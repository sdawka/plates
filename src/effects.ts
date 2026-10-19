// Executes the Effects returned by the domain service and the extraction module.
// Each effect runs on its own; a failure is logged and never stops the others.

import { getAsk, getAsksByRequest, getRequest, listEvents } from "./domain/repo";
import { publishHome } from "./home/home";
import { syncTracker } from "./trackers";
import { slackCall } from "./slack/api";
import { renderDm, renderRequest, type DmContext, type Rendered } from "./slack/blocks";
import type { AskRow, Effect, Env, RequestRow } from "./types";

type Of<K extends Effect["kind"]> = Extract<Effect, { kind: K }>;

/** Runs every effect; one failing never stops the others. Returns the ones that failed. */
export async function dispatch(env: Env, effects: Effect[]): Promise<Effect[]> {
  const unique = [...new Map(effects.map((e) => [JSON.stringify(e), e])).values()];
  const failed: Effect[] = [];
  await Promise.all(
    unique.map(async (effect) => {
      try {
        await run(env, effect);
      } catch (err) {
        console.error("effect failed", JSON.stringify(effect), err);
        failed.push(effect);
      }
    }),
  );
  return failed;
}

function run(env: Env, effect: Effect): Promise<unknown> {
  switch (effect.kind) {
    case "render_request": return renderRequestEffect(env, effect);
    case "dm": return dmEffect(env, effect);
    case "refresh_home": return publishHome(env, effect.userId);
    case "reschedule": return env.KEEPER.get(env.KEEPER.idFromName(effect.userId)).reschedule(effect.userId);
    case "thread_reply":
      return slackCall(env, "chat.postMessage", { channel: effect.channelId, thread_ts: effect.threadTs, text: effect.text });
    case "tracker_sync": return syncTracker(env, effect.askId);
  }
}

async function renderRequestEffect(env: Env, effect: Of<"render_request">): Promise<void> {
  const req = await getRequest(env.DB, effect.requestId);
  if (!req) return;
  const asks = req.status === "confirmed" ? await getAsksByRequest(env.DB, req.id) : [];
  const msg = renderRequest(req, asks);
  if (req.message_ts) {
    await slackCall(env, "chat.update", { channel: req.channel_id, ts: req.message_ts, ...msg });
    return;
  }
  const posted = await slackCall<{ ts: string }>(env, "chat.postMessage", {
    channel: req.channel_id,
    thread_ts: req.thread_ts,
    unfurl_links: false,
    ...msg,
  });
  // Claim the slot; a concurrent render that posted first wins and we take our duplicate down.
  const claim = await env.DB
    .prepare("UPDATE requests SET message_ts = ?, updated_at = ? WHERE id = ? AND message_ts IS NULL")
    .bind(posted.ts, Date.now(), req.id)
    .run();
  if (!claim.meta.changes) {
    await slackCall(env, "chat.delete", { channel: req.channel_id, ts: posted.ts });
  }
}

async function permalinkFor(env: Env, req: RequestRow): Promise<string | null> {
  try {
    const r = await slackCall<{ permalink: string }>(env, "chat.getPermalink", {
      channel: req.channel_id,
      message_ts: req.message_ts ?? req.thread_ts,
    });
    return r.permalink;
  } catch (err) {
    console.error("getPermalink failed", err);
    return null;
  }
}

async function dmEffect(env: Env, effect: Of<"dm">): Promise<void> {
  const reminderAsks = effect.template === "reminder" ? await loadAsks(env, effect.askIds ?? []) : undefined;
  // A reminder can span several requests; any one of them anchors the context.
  const req = await getRequest(env.DB, effect.requestId || (reminderAsks?.[0]?.request_id ?? ""));
  if (!req) return;
  const asks = await getAsksByRequest(env.DB, req.id);
  const ask = asks.find((a) => a.id === effect.askId) ?? null;
  const ctx: DmContext = {
    req,
    asks,
    ask,
    recipient: effect.userId,
    note: effect.note,
    deadline: effect.deadline,
    permalink: effect.template === "reminder" ? null : await permalinkFor(env, req),
    reminderAsks,
    actor: effect.template === "action_undone" && ask ? await lastUndoActor(env, ask.id) : undefined,
  };
  const rendered: Rendered | null = renderDm(effect.template, ctx);
  if (!rendered) return;
  await slackCall(env, "chat.postMessage", { channel: effect.userId, unfurl_links: false, ...rendered });
}

async function loadAsks(env: Env, ids: string[]): Promise<AskRow[]> {
  const asks = await Promise.all(ids.map((id) => getAsk(env.DB, id)));
  return asks.filter((a): a is AskRow => a !== null);
}

async function lastUndoActor(env: Env, askId: string): Promise<string | undefined> {
  const events = await listEvents(env.DB, askId);
  return events.filter((e) => e.kind === "undo").at(-1)?.actor_id;
}
