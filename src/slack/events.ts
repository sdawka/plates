// Slack Events API handlers. Everything here runs after the 3s ack (ctx.waitUntil).

import { dispatch } from "../effects";
import { getAsksByRequest, getRequestByMessage, getRequestsInThread } from "../domain/repo";
import { confirmDiscarded, confirmRequest } from "../domain/service";
import { publishHome } from "../home/home";
import { TransitionError, type Effect, type Env, type RequestRow } from "../types";
import { slackCall } from "./api";
import { CONFIRM_REACTIONS, WHATS_OFF_REPLY } from "./actions";
import { buildIntentJob, type MessageFile } from "./parse";

interface MessageLike {
  type: "app_mention" | "message";
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  channel_type?: string;
  files?: MessageFile[];
}
interface ReactionAdded {
  type: "reaction_added";
  user: string;
  reaction: string;
  item: { type: string; channel?: string; ts?: string };
}
interface HomeOpened {
  type: "app_home_opened";
  user: string;
  tab?: string;
}
export type SlackEvent = MessageLike | ReactionAdded | HomeOpened;

export interface EventContext {
  /** Our own bot user id, from the event envelope's `authorizations`. */
  botUserId: string | null;
}

export async function handleEvent(env: Env, event: SlackEvent, ec: EventContext): Promise<void> {
  switch (event.type) {
    case "app_mention": return onMention(env, event, ec);
    case "message": return onMessage(env, event, ec);
    case "reaction_added": return onReaction(env, event);
    case "app_home_opened":
      if (event.tab === "home") await publishHome(env, event.user);
      return;
  }
}

// ---------- app_mention ----------

async function onMention(env: Env, e: MessageLike, ec: EventContext): Promise<void> {
  if (!e.user || e.bot_id) return;
  // A mention inside a thread that already has a request is a correction or a follow-up, not a new capture.
  if (e.thread_ts && e.thread_ts !== e.ts && (await routeThreadReply(env, e, e.user, e.thread_ts, ec))) return;
  await env.EXTRACT_QUEUE.send({
    kind: "extract",
    channelId: e.channel,
    threadTs: e.thread_ts ?? null,
    messageTs: e.ts,
    taggerId: e.user,
    text: e.text ?? "",
  });
  await slackCall(env, "chat.postMessage", { channel: e.channel, thread_ts: e.thread_ts ?? e.ts, text: "Reading the thread…" });
}

// ---------- message in a thread ----------

const involved = (req: RequestRow, userId: string) =>
  userId === req.tagged_by_id || userId === req.requester_id || userId === req.owner_id;

/** Human messages only; a file upload arrives as subtype "file_share", a reply also sent to the channel as "thread_broadcast". Edits, joins, bot posts are ignored. */
const isHumanMessage = (e: MessageLike, ec: EventContext) =>
  (!e.subtype || e.subtype === "file_share" || e.subtype === "thread_broadcast") && !e.bot_id && !!e.user && e.user !== ec.botUserId;

async function onMessage(env: Env, e: MessageLike, ec: EventContext): Promise<void> {
  if (!isHumanMessage(e, ec) || !e.user) return;
  const user = e.user;

  // A top-level message in the bot's own DM is a capture.
  if (e.channel_type === "im" && (!e.thread_ts || e.thread_ts === e.ts)) {
    if (!(e.text ?? "").trim()) return;
    await env.EXTRACT_QUEUE.send({
      kind: "extract",
      channelId: e.channel,
      threadTs: null,
      messageTs: e.ts,
      taggerId: user,
      text: e.text ?? "",
      origin: "dm",
    });
    return;
  }

  if (!e.thread_ts || e.thread_ts === e.ts) return;
  if (ec.botUserId && e.text?.includes(`<@${ec.botUserId}>`)) return; // arrives as app_mention

  await routeThreadReply(env, e, user, e.thread_ts, ec);
}

/** Routes a reply in a thread to a correction or intent job; false when the thread has no request for this user. */
async function routeThreadReply(env: Env, e: MessageLike, user: string, threadTs: string, ec: EventContext): Promise<boolean> {
  const requests = await getRequestsInThread(env.DB, e.channel, threadTs);
  const pending = requests.filter((r) => r.status === "pending_confirmation").at(-1);
  if (pending && involved(pending, user)) {
    await env.EXTRACT_QUEUE.send({ kind: "correct", requestId: pending.id, userId: user, text: e.text ?? "", messageTs: e.ts });
    return true;
  }

  // Confirmed request: the requester, the owner, or an ask's current owner can act by replying.
  for (const req of requests.filter((r) => r.status === "confirmed")) {
    let eligible = user === req.requester_id || user === req.owner_id;
    if (!eligible) {
      const asks = await getAsksByRequest(env.DB, req.id);
      eligible = asks.some((a) => a.owner_id === user || a.requester_id === user);
    }
    if (eligible) {
      await env.EXTRACT_QUEUE.send({
        ...buildIntentJob({ channel: e.channel, ts: e.ts, thread_ts: threadTs, user, text: e.text, files: e.files }),
        ...(ec.botUserId && { botUserId: ec.botUserId }),
      });
      return true;
    }
  }
  return false;
}

// ---------- reaction_added ----------

const reactionName = (r: string) => r.split("::")[0] ?? r; // "+1::skin-tone-3" -> "+1"
const isIn = (list: readonly string[], r: string) => list.includes(r);

async function onReaction(env: Env, e: ReactionAdded): Promise<void> {
  if (e.item.type !== "message" || !e.item.channel || !e.item.ts) return;
  const req = await getRequestByMessage(env.DB, e.item.channel, e.item.ts);
  if (!req || req.status === "confirmed" || !involved(req, e.user)) return;

  const name = reactionName(e.reaction);
  if (isIn(CONFIRM_REACTIONS.yes, name)) return confirmFromReaction(env, req, e.user);
  if (isIn(CONFIRM_REACTIONS.no, name)) {
    return reply(env, req, WHATS_OFF_REPLY);
  }
  await env.EXTRACT_QUEUE.send({ kind: "clarify_reaction", requestId: req.id, userId: e.user, reaction: name });
}

async function confirmFromReaction(env: Env, req: RequestRow, userId: string): Promise<void> {
  let effects: Effect[];
  try {
    effects = await (req.status === "discarded" ? confirmDiscarded : confirmRequest)(env, req.id, userId, "reaction");
  } catch (err) {
    if (err instanceof TransitionError) return reply(env, req, err.userMessage);
    throw err;
  }
  await dispatch(env, effects);
}

async function reply(env: Env, req: RequestRow, text: string): Promise<void> {
  await dispatch(env, [{ kind: "thread_reply", channelId: req.channel_id, threadTs: req.thread_ts, text }]);
}
