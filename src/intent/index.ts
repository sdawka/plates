// Phase 2/3: turns a thread reply into an action (applied with Undo, or proposed with
// "Did you mean"), and spots owners delivering work without saying so.

import { getAsksByRequest, getPrefs, getRequestsInThread, newId } from "../domain/repo";
import { applyActionDetailed } from "../domain/service";
import { slackCall } from "../slack/api";
import type { Rendered } from "../slack/blocks";
import { mention } from "../slack/format";
import { TransitionError, type AskAction, type AskRow, type Effect, type Env, type ExtractJob } from "../types";
import { appliedMessage, proposalMessage } from "./messages";
import { PROPOSAL_TTL_MS, hasPendingDetector, insertProposal, setProposalMessage, sourceHandled } from "./proposals";
import { decideIntent } from "./questions";
import { buildCandidates, detectDelivery, validateDecision, type Candidate, type ValidateInput } from "./validate";

type IntentJob = Extract<ExtractJob, { kind: "intent" }>;

async function speakerTz(env: Env, userId: string): Promise<string> {
  const prefs = await getPrefs(env.DB, userId);
  if (prefs.updated_at > 0) return prefs.tz;
  try {
    const r = await slackCall<{ user?: { tz?: string } }>(env, "users.info", { user: userId });
    return r.user?.tz ?? "UTC";
  } catch (err) {
    console.error("users.info failed", err);
    return "UTC";
  }
}

/** Post in the thread; a failed post must never make the queue replay an applied action. */
async function postInThread(env: Env, job: IntentJob, msg: Rendered): Promise<string | null> {
  try {
    const r = await slackCall<{ ts: string }>(env, "chat.postMessage", {
      channel: job.channelId,
      thread_ts: job.threadTs,
      unfurl_links: false,
      ...msg,
    });
    return r.ts;
  } catch (err) {
    console.error("intent: thread post failed", err);
    return null;
  }
}

export async function handleIntentJob(env: Env, job: IntentJob): Promise<Effect[]> {
  const requests = (await getRequestsInThread(env.DB, job.channelId, job.threadTs)).filter((r) => r.status === "confirmed");
  if (requests.length === 0) return [];
  const asks = (await Promise.all(requests.map((r) => getAsksByRequest(env.DB, r.id)))).flat();
  const candidates = buildCandidates(asks, job.userId);
  if (candidates.every((c) => c.allowed.length === 0)) return [];
  if (!job.text.trim() && job.files.length === 0) return [];
  if (await sourceHandled(env.DB, job.channelId, job.messageTs)) return [];

  const tz = await speakerTz(env, job.userId);
  const now = Date.now();
  const shared = { speaker: job.userId, text: job.text, tz, now, candidates, links: job.links, files: job.files };
  const decision = await decideIntent(env, shared);
  const input: ValidateInput = { ...shared, decision, botUserId: job.botUserId };

  const outcome = validateDecision(input);
  let effects: Effect[] = [];
  if (outcome.kind === "act") {
    if (outcome.auto && outcome.askId) effects = await applyConfident(env, job, outcome.askId, outcome.action);
    else await propose(env, job, "reply", outcome.action, outcome.askId, outcome.eligible, outcome.askId === null);
  }

  // "Looks done?" only when nothing else already covers this message.
  const covered = outcome.kind === "act" && (outcome.auto || outcome.action.kind === "done");
  if (!covered) {
    const delivery = detectDelivery(input);
    if (delivery && !(await hasPendingDetector(env.DB, delivery.ask.id, now - PROPOSAL_TTL_MS))) {
      const only = candidates.filter((c) => c.ask.id === delivery.ask.id);
      await propose(env, job, "detector", delivery.action, delivery.ask.id, only, false);
    }
  }
  return effects;
}

async function applyConfident(env: Env, job: IntentJob, askId: string, action: AskAction): Promise<Effect[]> {
  try {
    const r = await applyActionDetailed(env, askId, action, job.userId, "thread_reply", job.messageTs);
    await postInThread(env, job, appliedMessage(job.userId, action, r.after, r.eventId));
    return r.effects;
  } catch (err) {
    // Confident but not possible after all (e.g. someone just changed the ask): say why, in the thread.
    if (err instanceof TransitionError) {
      await postInThread(env, job, { text: err.userMessage, blocks: [{ type: "section", text: { type: "mrkdwn", text: `${mention(job.userId)} ${err.userMessage}` } }] });
      return [];
    }
    throw err;
  }
}

async function propose(
  env: Env,
  job: IntentJob,
  source: "reply" | "detector",
  action: AskAction,
  askId: string | null,
  eligible: Candidate[],
  picker: boolean,
): Promise<void> {
  const ask: AskRow | null = askId ? eligible.find((c) => c.ask.id === askId)?.ask ?? null : null;
  const requestId = ask?.request_id ?? eligible[0]?.ask.request_id;
  if (!requestId) return;
  const id = newId();
  const now = Date.now();
  await insertProposal(env.DB, {
    id,
    source,
    request_id: requestId,
    ask_id: askId,
    actor_id: job.userId,
    action_json: JSON.stringify(action),
    channel_id: job.channelId,
    thread_ts: job.threadTs,
    source_ts: job.messageTs,
    message_ts: null,
    status: "pending",
    created_at: now,
    updated_at: now,
  });
  const ts = await postInThread(
    env,
    job,
    proposalMessage({ id, source, actor: job.userId, action, ask, options: eligible.map((c) => ({ id: c.ask.id, title: c.ask.title })), picker }),
  );
  if (ts) await setProposalMessage(env.DB, id, ts);
}
