// Executes the Effects returned by the domain service and the extraction module.
// Each effect runs on its own; a failure is logged and never stops the others.

import { getAsksByRequest, getRequest, updateRequest } from "./domain/repo";
import { publishHome } from "./home/home";
import { slackCall } from "./slack/api";
import { renderDm, renderRequest, type DmContext, type Rendered } from "./slack/blocks";
import type { Effect, Env, RequestRow } from "./types";

type Of<K extends Effect["kind"]> = Extract<Effect, { kind: K }>;

export async function dispatch(env: Env, effects: Effect[]): Promise<void> {
  const unique = [...new Map(effects.map((e) => [JSON.stringify(e), e])).values()];
  await Promise.all(
    unique.map(async (effect) => {
      try {
        await run(env, effect);
      } catch (err) {
        console.error("effect failed", JSON.stringify(effect), err);
      }
    }),
  );
}

function run(env: Env, effect: Effect): Promise<unknown> {
  switch (effect.kind) {
    case "render_request": return renderRequestEffect(env, effect);
    case "dm": return dmEffect(env, effect);
    case "refresh_home": return publishHome(env, effect.userId);
    case "reschedule": return env.KEEPER.get(env.KEEPER.idFromName(effect.userId)).reschedule(effect.userId);
    case "thread_reply":
      return slackCall(env, "chat.postMessage", { channel: effect.channelId, thread_ts: effect.threadTs, text: effect.text });
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
  await updateRequest(env.DB, req.id, { message_ts: posted.ts });
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
  const req = await getRequest(env.DB, effect.requestId);
  if (!req) return;
  const asks = await getAsksByRequest(env.DB, req.id);
  const ctx: DmContext = {
    req,
    asks,
    ask: asks.find((a) => a.id === effect.askId) ?? null,
    recipient: effect.userId,
    note: effect.note,
    deadline: effect.deadline,
    permalink: await permalinkFor(env, req),
  };
  const rendered: Rendered | null = renderDm(effect.template, ctx);
  if (!rendered) return;
  await slackCall(env, "chat.postMessage", { channel: effect.userId, unfurl_links: false, ...rendered });
}
