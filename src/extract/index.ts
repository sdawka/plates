// Extraction orchestration: turns queue jobs into persisted requests and effects.

import { confirmRequest } from "../domain/service";
import { getRequest, insertRequest, newId, updateRequest } from "../domain/repo";
import {
  TransitionError,
  type DraftAsk,
  type Effect,
  type Env,
  type ExtractJob,
  type RequestRow,
} from "../types";
import {
  ChannelUnreadableError,
  gatherForTag,
  gatherForThread,
  getPermalink,
  type ConversationContext,
} from "./context";
import { callClarify, callExtraction } from "./llm";
import { buildClarifyPrompt, buildCorrectionPrompt, buildExtractPrompt } from "./prompt";
import {
  DEFAULT_REACTION_QUESTION,
  NO_ASK_REPLY,
  isAffirmation,
  validateGroups,
  type ExtractedGroup,
} from "./validate";

const INVITE_REPLY = "I can't read this channel yet. Please invite me with `/invite @plates` and tag me again.";

const reply = (channelId: string, threadTs: string, text: string): Effect => ({ kind: "thread_reply", channelId, threadTs, text });

function fanOut(userIds: (string | null | undefined)[], reschedule: (string | null | undefined)[]): Effect[] {
  const home = [...new Set(userIds.filter((u): u is string => !!u))];
  const resched = [...new Set(reschedule.filter((u): u is string => !!u))];
  return [
    ...home.map((userId): Effect => ({ kind: "refresh_home", userId })),
    ...resched.map((userId): Effect => ({ kind: "reschedule", userId })),
  ];
}

function validateCtx(ctx: ConversationContext, permalinks?: Record<string, string | null>) {
  return {
    messageTs: new Set(ctx.messages.map((m) => m.ts)),
    userIds: new Set(ctx.participants.keys()),
    tzOf: (id: string | null) => (id ? ctx.participants.get(id)?.tz : undefined) ?? "UTC",
    permalinks,
  };
}

/** Fill source_permalink for cited messages only (reusing any permalink we already hold). */
async function attachPermalinks(
  env: Env,
  channelId: string,
  groups: ExtractedGroup[],
  known: Record<string, string | null> = {},
): Promise<void> {
  const cache = { ...known };
  const needed = new Set<string>();
  for (const g of groups) for (const a of g.asks) if (!(a.source_ts in cache)) needed.add(a.source_ts);
  await Promise.all(
    [...needed].map(async (ts) => {
      cache[ts] = await getPermalink(env, channelId, ts);
    }),
  );
  for (const g of groups) for (const a of g.asks) a.source_permalink = cache[a.source_ts] ?? a.source_permalink;
}

function newRequestRow(
  g: ExtractedGroup,
  base: { channelId: string; threadTs: string; taggerId: string; tagMessageTs: string | null },
): RequestRow {
  const now = Date.now();
  return {
    id: newId(),
    channel_id: base.channelId,
    thread_ts: base.threadTs,
    message_ts: null,
    tag_message_ts: base.tagMessageTs,
    status: "pending_confirmation",
    tagged_by_id: base.taggerId,
    requester_id: g.requester_id,
    owner_id: g.owner_id,
    attribution_confidence: g.attribution_confidence,
    attribution_reason: g.attribution_reason,
    clarify_question: g.clarify_question,
    draft_json: JSON.stringify(g.asks),
    confirmed_by: null,
    confirmed_via: null,
    nudged_at: null,
    created_at: now,
    updated_at: now,
  };
}

// ---------- extract ----------

async function handleExtract(env: Env, job: Extract<ExtractJob, { kind: "extract" }>): Promise<Effect[]> {
  const threadTs = job.threadTs ?? job.messageTs;

  // Queue redelivery: this exact tag message already produced a request (any status).
  const dup = await env.DB
    .prepare("SELECT id FROM requests WHERE channel_id = ? AND tag_message_ts = ? LIMIT 1")
    .bind(job.channelId, job.messageTs)
    .first<{ id: string }>();
  if (dup) return [];

  let ctx: ConversationContext;
  try {
    ctx = await gatherForTag(env, job.channelId, job.threadTs, job.messageTs, job.taggerId);
  } catch (e) {
    if (e instanceof ChannelUnreadableError) return [reply(job.channelId, threadTs, INVITE_REPLY)];
    throw e;
  }

  const raw = await callExtraction(
    env,
    buildExtractPrompt({ ctx, taggerId: job.taggerId, tagText: job.text, tagTs: job.messageTs, now: Date.now() }),
  );
  const groups = validateGroups(raw, validateCtx(ctx));
  if (groups.length === 0) return [reply(job.channelId, threadTs, NO_ASK_REPLY)];

  await attachPermalinks(env, job.channelId, groups);

  const effects: Effect[] = [];
  const people: (string | null)[] = [job.taggerId];
  const keepers: (string | null)[] = [];
  for (const g of groups) {
    const row = newRequestRow(g, { channelId: job.channelId, threadTs, taggerId: job.taggerId, tagMessageTs: job.messageTs });
    await insertRequest(env.DB, row);
    effects.push({ kind: "render_request", requestId: row.id });
    people.push(g.requester_id, g.owner_id);
    keepers.push(g.requester_id, g.owner_id);
  }
  return [...effects, ...fanOut(people, keepers)];
}

// ---------- correct ----------

async function handleCorrect(env: Env, job: Extract<ExtractJob, { kind: "correct" }>): Promise<Effect[]> {
  const req = await getRequest(env.DB, job.requestId);
  if (!req || req.status !== "pending_confirmation") return [];

  if (isAffirmation(job.text)) {
    try {
      return await confirmRequest(env, req.id, job.userId, "thread_reply");
    } catch (e) {
      if (e instanceof TransitionError) return [reply(req.channel_id, req.thread_ts, e.userMessage)];
      throw e;
    }
  }

  const drafts = JSON.parse(req.draft_json) as DraftAsk[];
  // If the original tag was top-level, its evidence lives in channel history before the thread root.
  const fromHistory = drafts.some((d) => Number(d.source_ts) < Number(req.thread_ts));
  const extra = [req.tagged_by_id, job.userId, req.requester_id, req.owner_id].filter((u): u is string => !!u);

  let ctx: ConversationContext;
  try {
    ctx = await gatherForThread(env, req.channel_id, req.thread_ts, fromHistory, extra);
  } catch (e) {
    if (e instanceof ChannelUnreadableError) return [reply(req.channel_id, req.thread_ts, INVITE_REPLY)];
    throw e;
  }

  const raw = await callExtraction(
    env,
    buildCorrectionPrompt({
      ctx,
      taggerId: req.tagged_by_id,
      speakerId: job.userId,
      correction: job.text,
      current: {
        requesterId: req.requester_id,
        ownerId: req.owner_id,
        confidence: req.attribution_confidence,
        reason: req.attribution_reason,
        asks: drafts,
      },
      now: Date.now(),
    }),
  );
  const groups = validateGroups(raw, validateCtx(ctx));
  const [first, ...rest] = groups;
  if (!first) {
    return [
      reply(
        req.channel_id,
        req.thread_ts,
        "That would leave nothing on the plate. Tell me what to change, or just ignore this request.",
      ),
    ];
  }

  const known: Record<string, string | null> = {};
  for (const d of drafts) known[d.source_ts] = d.source_permalink;
  await attachPermalinks(env, req.channel_id, groups, known);

  await updateRequest(env.DB, req.id, {
    requester_id: first.requester_id,
    owner_id: first.owner_id,
    attribution_confidence: first.attribution_confidence,
    attribution_reason: first.attribution_reason,
    clarify_question: first.clarify_question,
    draft_json: JSON.stringify(first.asks),
  });

  const effects: Effect[] = [{ kind: "render_request", requestId: req.id }];
  const people: (string | null)[] = [req.tagged_by_id, req.requester_id, req.owner_id, first.requester_id, first.owner_id];
  const keepers: (string | null)[] = [req.requester_id, req.owner_id, first.requester_id, first.owner_id];
  for (const g of rest) {
    const row = newRequestRow(g, { channelId: req.channel_id, threadTs: req.thread_ts, taggerId: req.tagged_by_id, tagMessageTs: null });
    await insertRequest(env.DB, row);
    effects.push({ kind: "render_request", requestId: row.id });
    people.push(g.requester_id, g.owner_id);
    keepers.push(g.requester_id, g.owner_id);
  }
  return [...effects, ...fanOut(people, keepers)];
}

// ---------- clarify_reaction ----------

async function handleClarifyReaction(env: Env, job: Extract<ExtractJob, { kind: "clarify_reaction" }>): Promise<Effect[]> {
  const req = await getRequest(env.DB, job.requestId);
  if (!req || req.status !== "pending_confirmation") return [];

  const hasDoubt = !req.requester_id || !req.owner_id || !!req.clarify_question || req.attribution_confidence < 0.8;
  let text = DEFAULT_REACTION_QUESTION;
  if (hasDoubt) {
    try {
      const q = await callClarify(
        env,
        buildClarifyPrompt({
          reaction: job.reaction,
          reactorId: job.userId,
          requesterId: req.requester_id,
          ownerId: req.owner_id,
          confidence: req.attribution_confidence,
          reason: req.attribution_reason,
          clarifyQuestion: req.clarify_question,
          asks: JSON.parse(req.draft_json) as DraftAsk[],
        }),
      );
      if (q) text = q;
    } catch {
      // Fall back to the default text; a clarifying question is never worth a retry.
    }
  }
  return [reply(req.channel_id, req.thread_ts, text)];
}

/** Handle one queued job. Persists requests, returns effects (render_request, thread_reply, ...). */
export async function handleExtractJob(env: Env, job: ExtractJob): Promise<Effect[]> {
  switch (job.kind) {
    case "extract":
      return handleExtract(env, job);
    case "correct":
      return handleCorrect(env, job);
    case "clarify_reaction":
      return handleClarifyReaction(env, job);
  }
}
