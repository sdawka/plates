// Minimal Slack Web API client shared by all modules.

import type { Env } from "../types";

export class SlackApiError extends Error {
  constructor(public readonly method: string, public readonly error: string) {
    super(`slack ${method}: ${error}`);
  }
}

export async function slackCall<T = Record<string, unknown>>(
  env: Pick<Env, "SLACK_BOT_TOKEN" | "SLACK_API_URL">,
  method: string,
  body: Record<string, unknown>,
): Promise<T & { ok: true }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${env.SLACK_API_URL ?? "https://slack.com/api"}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: formEncode(body),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new SlackApiError(method, json.error ?? `http_${res.status}`);
    return json as T & { ok: true };
  }
}

/**
 * Form encoding works for every Web API method; several read methods (conversations.history,
 * conversations.replies, users.info) ignore JSON bodies. Objects and arrays (blocks, view) are sent
 * as JSON strings, as Slack documents for form-encoded calls.
 */
export function formEncode(body: Record<string, unknown>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return form.toString();
}

/** Slack's minimal message shape as returned by conversations.replies / history. */
export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  files?: { id: string; name?: string; title?: string; permalink?: string }[];
}
