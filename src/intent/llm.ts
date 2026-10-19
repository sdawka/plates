// Claude call for thread-reply intent. Throws on transient failures (the queue retries).

import { callTool } from "../llm";
import type { Env } from "../types";
import { INTENT_SYSTEM, INTENT_TOOL, INTENT_TOOL_NAME } from "./prompt";

export async function callIntent(env: Env, prompt: string): Promise<unknown> {
  return callTool(env, {
    model: env.FAST_MODEL,
    maxTokens: 1024,
    retryMaxTokens: 2048,
    system: INTENT_SYSTEM,
    tool: INTENT_TOOL,
    prompt,
  });
}
