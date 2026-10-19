// Claude call for thread-reply intent. Throws on transient failures (the queue retries).

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";
import { INTENT_SYSTEM, INTENT_TOOL, INTENT_TOOL_NAME } from "./prompt";

export async function callIntent(env: Env, prompt: string): Promise<unknown> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });
  const res = await client.messages.create({
    model: env.FAST_MODEL,
    max_tokens: 600,
    system: INTENT_SYSTEM,
    tools: [INTENT_TOOL],
    tool_choice: { type: "tool", name: INTENT_TOOL_NAME },
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content.find((b) => b.type === "tool_use" && b.name === INTENT_TOOL_NAME);
  if (!block || block.type !== "tool_use") throw new Error("intent: model returned no tool_use block");
  return block.input;
}
