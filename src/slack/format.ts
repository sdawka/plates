// Small mrkdwn helpers shared by the block renderers.

import { SIZE_LABEL, type AskRow, type DraftAsk, type Urgency } from "../types";

export const mention = (userId: string) => `<@${userId}>`;

/** Escape the three characters Slack treats as control characters in mrkdwn. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** Slack date token: each viewer sees the date in their own timezone. */
export function dateToken(ms: number): string {
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty}|${new Date(ms).toISOString().slice(0, 10)}>`;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const urgencyLabel: Record<Urgency, string> = { low: "low", normal: "normal", high: "high", urgent: "urgent" };

export function sizeUrgency(a: Pick<AskRow | DraftAsk, "size" | "urgency">): string {
  return `${SIZE_LABEL[a.size]} · ${urgencyLabel[a.urgency]}`;
}

/** Only http(s) links are rendered as links. */
export const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

export const link = (url: string, text: string) => `<${url}|${esc(text)}>`;
