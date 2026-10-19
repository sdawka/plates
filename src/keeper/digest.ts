// Pure builder for the daily digest DM. No Workers imports.

import { SIZE_LABEL, type AskRow, type AskState } from "../types";

export interface Digest {
  text: string;
  blocks: Record<string, unknown>[];
}

const NEEDS_RESPONSE: readonly AskState[] = ["proposed", "delivered", "rejected", "clarify"];
const ON_MY_PLATE: readonly AskState[] = ["in_progress", "accepted", "snoozed"];
const MAX_LINES_PER_SECTION = 15;

const STATE_LABEL: Partial<Record<AskState, string>> = {
  proposed: "proposed",
  delivered: "delivered, waiting for you to close",
  rejected: "rejected",
  clarify: "needs info from you",
  in_progress: "in progress",
  accepted: "accepted",
};

const mention = (id: string) => `<@${id}>`;

/** Slack renders this in the reader's own time zone; the text after | is the fallback. */
function slackDate(ms: number, format: string): string {
  return `<!date^${Math.floor(ms / 1000)}^${format}|${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC>`;
}

/** The person on the other side of the ask from `userId`. */
function counterparty(ask: AskRow, userId: string): string {
  return ask.requester_id === userId ? ask.owner_id : ask.requester_id;
}

function describe(ask: AskRow, userId: string): string {
  const who = counterparty(ask, userId);
  const parts = [`${SIZE_LABEL[ask.size]}`, ask.urgency];
  if (ask.state === "snoozed") {
    const wake = ask.snoozed_until ? ` until ${slackDate(ask.snoozed_until, "{date_short_pretty} {time}")}` : "";
    parts.push(`💤${wake} ×${ask.snooze_count}`);
  } else {
    parts.push(STATE_LABEL[ask.state] ?? ask.state);
  }
  if (ask.deadline_at) parts.push(`due ${slackDate(ask.deadline_at, "{date_short_pretty}")}`);
  const direction = ask.requester_id === userId ? `from ${mention(who)}` : `for ${mention(who)}`;
  return `• *${ask.title}* (${direction}) · ${parts.join(" · ")}`;
}

function countsLine(asks: AskRow[], userId: string): string {
  const counts = new Map<string, number>();
  for (const a of asks) {
    const who = counterparty(a, userId);
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  return [...counts].map(([who, n]) => `${mention(who)} ×${n}`).join(", ");
}

function section(title: string, asks: AskRow[], userId: string): Record<string, unknown>[] {
  const shown = asks.slice(0, MAX_LINES_PER_SECTION).map((a) => describe(a, userId));
  if (asks.length > shown.length) shown.push(`…and ${asks.length - shown.length} more`);
  return [
    { type: "header", text: { type: "plain_text", text: `${title} (${asks.length})`, emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: countsLine(asks, userId) }] },
    { type: "section", text: { type: "mrkdwn", text: shown.join("\n") } },
  ];
}

const oldestFirst = (a: AskRow, b: AskRow) => a.created_at - b.created_at;

/** Null when there is nothing on the user's plate (the digest is skipped). */
export function buildDigest(userId: string, plate: AskRow[]): Digest | null {
  const mine = plate.filter((a) => a.holder_id === userId);
  const needs = mine.filter((a) => NEEDS_RESPONSE.includes(a.state)).sort(oldestFirst);
  const onPlate = mine.filter((a) => ON_MY_PLATE.includes(a.state)).sort(oldestFirst);
  if (needs.length === 0 && onPlate.length === 0) return null;

  const blocks: Record<string, unknown>[] = [
    { type: "section", text: { type: "mrkdwn", text: "*Your daily Plates digest*" } },
  ];
  if (needs.length > 0) blocks.push(...section("Needs your response", needs, userId));
  if (onPlate.length > 0) blocks.push(...section("On my plate", onPlate, userId));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Open Plates' Home tab to manage these." }],
  });

  return {
    text: `Plates digest: ${needs.length} needing your response, ${onPlate.length} on your plate`,
    blocks,
  };
}
