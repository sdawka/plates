// Extraction orchestration: turns queue jobs into persisted requests and effects.

import { decide, pMax } from "../decide";
import { LlmPermanentError } from "../llm";
import { handleIntentJob } from "../intent";
import { connectUrl, getUserToken } from "../oauth";
import { WHATS_OFF_REPLY } from "../slack/actions";
import { SlackApiError, slackCall } from "../slack/api";
import { confirmRequest } from "../domain/service";
import { getRequest, insertRequest, insertRequestStmt, newId, updateRequest } from "../domain/repo";
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
  buildContext,
  gatherForTag,
  gatherForThread,
  getPermalink,
  singleMessage,
  withCommandMessage,
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

const DEAD_TOKEN = new Set(["token_revoked", "invalid_auth", "not_authed", "account_inactive", "token_expired"]);
type ChannelKind = "im" | "mpim" | "private" | "public" | "unknown";

/**
 * What kind of conversation the bot can't read. Prefers conversations.info with the tagger's user token, then the
 * shortcut payload's channel name, then the id prefix (D = DM, G = group DM; C stays "unknown" → invite).
 */
async function classifyChannel(env: Env, job: Extract<ExtractJob, { kind: "extract" }>, token: string | null): Promise<ChannelKind> {
  if (token) {
    try {
      const r = await slackCall<{ channel?: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_group?: boolean } }>(
        { ...env, SLACK_BOT_TOKEN: token },
        "conversations.info",
        { channel: job.channelId },
      );
      const c = r.channel;
      if (c) {
        if (c.is_im) return "im";
        if (c.is_mpim) return "mpim";
        return c.is_private || c.is_group ? "private" : "public";
      }
    } catch (e) {
      if (!(e instanceof SlackApiError)) throw e;
    }
  }
  const name = (job as { channelName?: string }).channelName;
  if (name === "directmessage") return "im";
  if (name?.startsWith("mpdm-")) return "mpim";
  if (name === "privategroup") return "private";
  if (job.channelId.startsWith("D")) return "im";
  if (job.channelId.startsWith("G")) return "mpim";
  return "unknown";
}

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

/** Below this a DM to the bot is not an ask, so nothing is extracted. */
const IS_ASK_MIN = 0.3;
const NOT_AN_ASK_REPLY = "I track asks, like `remind me to send Dana the Q3 deck by Friday`. You can also ask me “what's on my plate?”, or say `help`.";

/** Cheap filter before the extraction call: does the DM ask someone to do, deliver, decide or acknowledge something? */
async function looksLikeAsk(env: Env, text: string): Promise<boolean> {
  const { is_ask } = await decide(env, {
    state: { untrusted_chat_message: text.slice(0, 2000) },
    questions: { is_ask: { type: "noul", instructions: "The message asks someone to do, deliver, decide or acknowledge something." } },
  });
  return is_ask.noul >= IS_ASK_MIN;
}

async function handleExtract(env: Env, job: Extract<ExtractJob, { kind: "extract" }>): Promise<Effect[]> {
  const threadTs = job.threadTs ?? job.messageTs;

  // Queue redelivery: this exact tag message already produced its requests (any status).
  // Re-render any whose message never got posted (e.g. Slack failed on the first attempt).
  const existing = await env.DB
    .prepare("SELECT id, message_ts, channel_id FROM requests WHERE tag_message_ts = ? AND (channel_id = ? OR tagged_by_id = ?)")
    .bind(job.messageTs, job.channelId, job.taggerId)
    .all<{ id: string; message_ts: string | null; channel_id: string }>();
  if (existing.results.length > 0) {
    const unposted = existing.results.filter((r) => !r.message_ts);
    if (unposted.length === 0 && job.origin && job.origin !== "mention") {
      // A deliberate re-capture of something already on a plate: say so instead of staying silent.
      const first = existing.results[0]!;
      const link = first.message_ts ? await getPermalink(env, first.channel_id, first.message_ts) : null;
      await slackCall(env, "chat.postMessage", {
        channel: job.taggerId,
        text: link ? `That's already on a plate: ${link}` : "That's already on a plate.",
      });
    }
    return unposted.map((r): Effect => ({ kind: "render_request", requestId: r.id }));
  }

  if (job.origin === "dm" && !(await looksLikeAsk(env, job.text))) {
    await slackCall(env, "chat.postMessage", { channel: job.channelId, text: NOT_AN_ASK_REPLY });
    return [];
  }

  let ctx: ConversationContext;
  let readEnv: Env = env; // credentials that can read the source conversation
  let dmFallback = false; // the request must live in the tagger's DM with the bot
  let kind: ChannelKind = "unknown";
  let single = false; // only the captured message could be read
  try {
    ctx = await gatherForTag(env, job.channelId, job.threadTs, job.messageTs, job.taggerId);
    if (job.origin === "command") ctx = await withCommandMessage(env, ctx, job.messageTs, job.taggerId, job.text);
  } catch (e) {
    if (!(e instanceof ChannelUnreadableError)) throw e;
    if (job.origin !== "shortcut") return [reply(job.channelId, threadTs, INVITE_REPLY)];
    const token = await getUserToken(env, job.taggerId);
    kind = await classifyChannel(env, job, token);
    if (kind !== "im" && kind !== "mpim") {
      // The bot isn't in that channel, so it can't reply there either: tell the tagger directly.
      await slackCall(env, "chat.postMessage", { channel: job.taggerId, text: INVITE_REPLY });
      return [];
    }
    dmFallback = true;
    let viaToken: ConversationContext | null = null;
    if (token) {
      const userEnv = { ...env, SLACK_BOT_TOKEN: token };
      try {
        viaToken = await gatherForTag(env, job.channelId, job.threadTs, job.messageTs, job.taggerId, userEnv);
        readEnv = userEnv;
      } catch (err) {
        const dead = err instanceof SlackApiError && DEAD_TOKEN.has(err.error);
        if (!(err instanceof ChannelUnreadableError) && !dead) throw err;
      }
    }
    if (viaToken) ctx = viaToken;
    else {
      single = true;
      ctx = await buildContext(env, singleMessage(job.messageTs, job.sourceUserId ?? job.taggerId, job.text), [job.taggerId]);
    }
  }

  const raw = await callExtraction(
    env,
    buildExtractPrompt({
      ctx,
      taggerId: job.taggerId,
      tagText: job.text,
      tagTs: job.messageTs,
      now: Date.now(),
      origin: job.origin,
      sourceUserId: job.sourceUserId,
      singleMessage: single,
    }),
  );
  const groups = validateGroups(raw, validateCtx(ctx));

  let target = { channelId: job.channelId, threadTs };
  let capturedLink: string | null = null;
  if (dmFallback) {
    // The bot can't post in that DM: the request lives in the tagger's DM with the bot.
    const opened = await slackCall<{ channel?: { id: string } }>(env, "conversations.open", { users: job.taggerId });
    const dmId = opened.channel?.id;
    if (!dmId) throw new Error("conversations.open returned no channel");
    if (groups.length === 0) {
      await slackCall(env, "chat.postMessage", { channel: dmId, text: NO_ASK_REPLY });
      return [];
    }
    capturedLink = readEnv === env ? null : await getPermalink(readEnv, job.channelId, job.messageTs);
    const other = job.sourceUserId && job.sourceUserId !== job.taggerId ? job.sourceUserId : null;
    const where = kind === "im" ? (other ? `your DM with <@${other}>` : "your DM") : "a group DM";
    const anchor = await slackCall<{ ts: string }>(env, "chat.postMessage", {
      channel: dmId,
      text: `From ${where}${capturedLink ? `: ${capturedLink}` : ""}`,
    });
    target = { channelId: dmId, threadTs: anchor.ts };
  } else if (groups.length === 0) {
    return [reply(job.channelId, threadTs, NO_ASK_REPLY)];
  }

  await attachPermalinks(readEnv, job.channelId, groups, dmFallback ? { [job.messageTs]: capturedLink } : {});

  const effects: Effect[] = [];
  const people: (string | null)[] = [job.taggerId];
  const keepers: (string | null)[] = [];
  const rows = groups.map((g) => newRequestRow(g, { ...target, taggerId: job.taggerId, tagMessageTs: job.messageTs }));
  await env.DB.batch(rows.map((row) => insertRequestStmt(env.DB, row))); // all groups or none
  for (const row of rows) {
    effects.push({ kind: "render_request", requestId: row.id });
    people.push(row.requester_id, row.owner_id);
    keepers.push(row.requester_id, row.owner_id);
    if (dmFallback) {
      // Only the tagger can see the confirmation in their bot DM; ask the people who can confirm directly.
      for (const userId of new Set([row.requester_id, row.owner_id])) {
        if (userId && userId !== job.taggerId) {
          effects.push({ kind: "dm", userId, template: "confirm_request", requestId: row.id, ...(capturedLink && { note: capturedLink }) });
        }
      }
    }
  }

  if (single) {
    const url = await connectUrl(env, job.taggerId);
    if (url) {
      try {
        await slackCall(env, "chat.postMessage", {
          channel: target.channelId,
          text: `I could only see the one message. Connect Plates to read the whole DM: <${url}>`,
        });
      } catch {
        // The request is already saved; a missed hint isn't worth a retry.
      }
    }
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

  // Evidence from a DM we can't re-read (captured via shortcut) survives only as the stored draft.
  const have = new Set(ctx.messages.map((m) => m.ts));
  for (const d of drafts) {
    if (have.has(d.source_ts)) continue;
    have.add(d.source_ts);
    ctx.messages.push({
      ts: d.source_ts,
      userId: null,
      name: "earlier message",
      text: `(original text no longer available; captured as: ${d.title}${d.detail ? ` — ${d.detail}` : ""})`,
      files: [],
    });
  }
  ctx.messages.sort((a, b) => Number(a.ts) - Number(b.ts));

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

  // Guarded: a concurrent confirm must win, so only update while still pending.
  const upd = await env.DB
    .prepare(
      "UPDATE requests SET requester_id = ?, owner_id = ?, attribution_confidence = ?, attribution_reason = ?, clarify_question = ?, draft_json = ?, updated_at = ? WHERE id = ? AND status = 'pending_confirmation'",
    )
    .bind(
      first.requester_id ?? null,
      first.owner_id ?? null,
      first.attribution_confidence,
      first.attribution_reason ?? null,
      first.clarify_question ?? null,
      JSON.stringify(first.asks),
      Date.now(),
      req.id,
    )
    .run();
  if (!upd.meta.changes) {
    return [reply(req.channel_id, req.thread_ts, "That request was already confirmed, so I couldn't change it.")];
  }

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

/** Below this probability an emoji is not taken as a yes or a no. */
const REACTION_MIN = 0.8;

/** Does an unrecognized emoji on a confirmation mean yes or no? Anything unsure (or a failed call) is "unclear". */
async function readReaction(env: Env, req: RequestRow, job: Extract<ExtractJob, { kind: "clarify_reaction" }>): Promise<"yes" | "no" | "unclear"> {
  try {
    const { meaning } = await decide(env, {
      state: {
        emoji: job.reaction,
        reacted_by: job.userId,
        confirmation: {
          requester: req.requester_id,
          owner: req.owner_id,
          asks: (JSON.parse(req.draft_json) as DraftAsk[]).map((a) => a.title),
        },
      },
      questions: {
        meaning: {
          type: "choice",
          instructions: "The person reacted to a confirmation ('is this who asked whom for what?') with this emoji. What do they mean?",
          criteria: {
            yes: "Approval: the summary is right.",
            no: "Disapproval: the summary is wrong or something is off.",
            unclear: "The emoji says nothing about whether the summary is right.",
          },
        },
      },
    });
    return (meaning.choice === "yes" || meaning.choice === "no") && pMax(meaning) >= REACTION_MIN ? meaning.choice : "unclear";
  } catch (e) {
    console.error("clarify_reaction: decide failed", e);
    return "unclear";
  }
}

async function handleClarifyReaction(env: Env, job: Extract<ExtractJob, { kind: "clarify_reaction" }>): Promise<Effect[]> {
  const req = await getRequest(env.DB, job.requestId);
  if (!req || req.status !== "pending_confirmation") return [];

  const meaning = await readReaction(env, req, job);
  if (meaning === "yes") {
    try {
      return await confirmRequest(env, req.id, job.userId, "reaction");
    } catch (e) {
      if (e instanceof TransitionError) return [reply(req.channel_id, req.thread_ts, e.userMessage)];
      throw e;
    }
  }
  if (meaning === "no") return [reply(req.channel_id, req.thread_ts, WHATS_OFF_REPLY)];

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
  try {
    return await routeJob(env, job);
  } catch (e) {
    if (!(e instanceof LlmPermanentError)) throw e;
    console.error("extract job: permanent LLM failure", job.kind, e.message);
    return failureReply(env, job, LLM_FAILED_REPLY);
  }
}

const LLM_FAILED_REPLY = "Sorry, I couldn't work out the asks in this thread. Tag me again with a short note, e.g. `@plates @bob send the Q3 numbers`.";
export const JOB_FAILED_REPLY = "Sorry, something went wrong while I was reading this. Please tag me again.";

/** Where to tell people a job failed. Intent jobs fail silently: nobody asked the bot anything. */
export async function failureReply(env: Env, job: ExtractJob, text: string): Promise<Effect[]> {
  if (job.kind === "extract") return [reply(job.channelId, job.threadTs ?? job.messageTs, text)];
  if (job.kind === "intent") return [];
  const req = await getRequest(env.DB, job.requestId);
  return req ? [reply(req.channel_id, req.thread_ts, text)] : [];
}

async function routeJob(env: Env, job: ExtractJob): Promise<Effect[]> {
  switch (job.kind) {
    case "extract":
      return handleExtract(env, job);
    case "correct":
      return handleCorrect(env, job);
    case "clarify_reaction":
      return handleClarifyReaction(env, job);
    case "intent":
      return handleIntentJob(env, job);
  }
}
