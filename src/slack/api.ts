// Minimal Slack Web API client shared by all modules.

import type { Env } from "../types";

export class SlackApiError extends Error {
  constructor(public readonly method: string, public readonly error: string) {
    super(`slack ${method}: ${error}`);
  }
}

export async function slackCall<T = Record<string, unknown>>(
  env: Pick<Env, "SLACK_BOT_TOKEN">,
  method: string,
  body: Record<string, unknown>,
): Promise<T & { ok: true }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
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
