// Pure parsing helpers for message events and slash commands (no I/O, unit-testable in node).

import type { ExtractJob } from "../types";

export type IntentJob = Extract<ExtractJob, { kind: "intent" }>;

const unescapeSlack = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Links in Slack mrkdwn: `<https://x.test/a|label>` or `<https://x.test/a>`. Deduplicated, in order. */
export function linksFromText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g)) {
    const url = unescapeSlack(m[1] ?? "");
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

export interface MessageFile {
  name?: string;
  title?: string;
  permalink?: string;
}

export function buildIntentJob(e: {
  channel: string;
  ts: string;
  thread_ts: string;
  user: string;
  text?: string;
  files?: MessageFile[];
}): IntentJob {
  const text = e.text ?? "";
  return {
    kind: "intent",
    channelId: e.channel,
    threadTs: e.thread_ts,
    messageTs: e.ts,
    userId: e.user,
    text,
    files: (e.files ?? []).map((f) => ({ name: f.title ?? f.name ?? null, permalink: f.permalink ?? null })),
    links: linksFromText(text),
  };
}

// ---------- slash command ----------

export interface SlashCommand {
  command: string;
  text: string;
  userId: string;
  channelId: string;
  responseUrl: string;
  triggerId: string;
}

/** Null when the form body isn't a slash command. */
export function parseSlashCommand(params: URLSearchParams): SlashCommand | null {
  const command = params.get("command");
  const userId = params.get("user_id");
  const channelId = params.get("channel_id");
  if (!command || !userId || !channelId) return null;
  return {
    command,
    text: params.get("text") ?? "",
    userId,
    channelId,
    responseUrl: params.get("response_url") ?? "",
    triggerId: params.get("trigger_id") ?? "",
  };
}

export type SlashAction = { kind: "help" } | { kind: "settings" } | { kind: "capture"; text: string };

/** With `should_escape: true` mentions arrive as `<@U123|bob>`; plain `<@U123>` renders the same. */
export const normalizeCommandText = (text: string): string =>
  text.trim().replace(/<@([UW][A-Z0-9]+)\|[^>]*>/g, "<@$1>");

export function parseSlashText(raw: string): SlashAction {
  const text = normalizeCommandText(raw);
  const word = text.toLowerCase();
  if (word === "" || word === "help") return { kind: "help" };
  if (word === "settings") return { kind: "settings" };
  return { kind: "capture", text };
}

export const HELP_TEXT = [
  "*Plates* keeps track of who asked whom for what.",
  "• `/plates @bob send me the Q3 deck by Friday` puts an ask on someone's plate",
  "• `/plates settings` sets your time zone, digest time, working hours and reminder limit",
  "• Tag @plates in a thread, use the message shortcut (⋯ → Put on someone's plate), or just DM me",
  "• In a thread with a request, reply in plain language (\"rejecting this, marketing owns it\") to act on it",
].join("\n");

export const commandPostText = (userId: string, text: string) => `<@${userId}> via /plates: ${text}`;
