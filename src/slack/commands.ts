// /plates slash command. Slack wants an answer within 3 seconds, so every branch acks first and
// does its Slack calls in ctx.waitUntil (the trigger_id for the settings modal lives 3 seconds too).

import { getPrefs } from "../domain/repo";
import { loadDmAccess } from "../home/home";
import { TransitionError, type Env } from "../types";
import type { Block } from "./blocks";
import { slackCall, SlackApiError } from "./api";
import { helpMessage } from "./help";
import { commandPostText, parseSlashCommand, parseSlashText, type SlashCommand } from "./parse";
import { buildSettingsModal } from "./settings";

const NOT_IN_CHANNEL = new Set(["not_in_channel", "channel_not_found", "is_archived"]);
const INVITE_TEXT = "I'm not in this channel yet. Invite me with `/invite @plates` and run the command again.";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const ack = () => new Response(null, { status: 200 });

/** Null when the form body isn't a slash command (so the caller can fall through). */
export function handleSlashCommand(env: Env, ctx: ExecutionContext, params: URLSearchParams): Response | null {
  const cmd = parseSlashCommand(params);
  if (!cmd) return null;
  const action = parseSlashText(cmd.text);
  switch (action.kind) {
    case "help":
      return json({ response_type: "ephemeral", ...helpMessage() });
    case "settings":
      ctx.waitUntil(openSettings(env, cmd.triggerId, cmd.userId).catch((err) => console.error("settings modal failed", err)));
      return ack();
    case "capture":
      ctx.waitUntil(capture(env, cmd, action.text).catch((err) => console.error("/plates capture failed", err)));
      return ack();
  }
}

export async function userTzOf(env: Env, userId: string): Promise<string> {
  try {
    const r = await slackCall<{ user?: { tz?: string } }>(env, "users.info", { user: userId });
    return r.user?.tz ?? "UTC";
  } catch (err) {
    console.error("users.info failed", err);
    return "UTC";
  }
}

/** Opens the settings modal; the time zone defaults to the Slack profile's when nothing is saved. */
export async function openSettings(env: Env, triggerId: string, userId: string): Promise<void> {
  await openModalLazily(env, triggerId, "Plates settings", async () => {
    const prefs = await getPrefs(env.DB, userId);
    const [tz, dm] = await Promise.all([
      prefs.updated_at > 0 ? prefs.tz : userTzOf(env, userId),
      loadDmAccess(env, userId).catch(() => undefined),
    ]);
    return buildSettingsModal(prefs, tz, dm);
  });
}

const loadingView = (title: string, text: string, closable: boolean) => ({
  type: "modal",
  title: { type: "plain_text", text: title.slice(0, 24) },
  ...(closable ? { close: { type: "plain_text", text: "Close" } } : {}),
  blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
});

/**
 * views.open must land within 3s of the trigger_id, so open a placeholder right away and swap in the
 * real view (built after slower D1 / Slack lookups) with views.update. A TransitionError from `build`
 * is shown inside the modal.
 */
export async function openModalLazily(env: Env, triggerId: string, title: string, build: () => Promise<Block>): Promise<void> {
  if (!triggerId) return;
  const opened = await slackCall<{ view: { id: string; hash: string } }>(env, "views.open", {
    trigger_id: triggerId,
    view: loadingView(title, "Loading…", false),
  });
  const { id, hash } = opened.view;
  try {
    await slackCall(env, "views.update", { view_id: id, hash, view: await build() });
  } catch (err) {
    if (!(err instanceof TransitionError)) throw err;
    await slackCall(env, "views.update", { view_id: id, hash, view: loadingView(title, err.userMessage, true) });
  }
}

async function respond(url: string, text: string): Promise<void> {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
}

/** The bot reposts user text, so <!channel>, <!here>, <!everyone> and <!subteam^…> must not stay live. */
export const neutralizeBroadcasts = (text: string) => text.replaceAll("<!", "&lt;!");

/** Post the text as the bot so the thread has a message to read, then queue extraction on it. */
async function capture(env: Env, cmd: SlashCommand, text: string): Promise<void> {
  let ts: string;
  try {
    const posted = await slackCall<{ ts: string }>(env, "chat.postMessage", {
      channel: cmd.channelId,
      text: commandPostText(cmd.userId, neutralizeBroadcasts(text)),
      unfurl_links: false,
    });
    ts = posted.ts;
  } catch (err) {
    if (err instanceof SlackApiError && NOT_IN_CHANNEL.has(err.error)) return respond(cmd.responseUrl, INVITE_TEXT);
    throw err;
  }
  await env.EXTRACT_QUEUE.send({
    kind: "extract",
    channelId: cmd.channelId,
    threadTs: ts,
    messageTs: ts,
    taggerId: cmd.userId,
    text,
    origin: "command",
  });
}
