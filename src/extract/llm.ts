// Claude calls. Throws on transient failures (the queue retries); returns raw tool input otherwise.

import { PROVIDER_ROUTING, callTool, llmClient } from "../llm";
import type { Env } from "../types";
import { CLARIFY_SYSTEM, EXTRACT_SYSTEM, EXTRACT_TOOL, EXTRACT_TOOL_NAME } from "./prompt";

/** Run the extraction tool call and return the tool input (unvalidated). */
export async function callExtraction(env: Env, prompt: string): Promise<unknown> {
  return callTool(env, {
    model: env.EXTRACT_MODEL,
    maxTokens: 8192,
    retryMaxTokens: 16384,
    system: EXTRACT_SYSTEM,
    tool: EXTRACT_TOOL,
    prompt,
  });
}

/** One short clarifying question from the fast model; null when it produced nothing usable. */
export async function callClarify(env: Env, prompt: string): Promise<string | null> {
  const res = await llmClient(env).messages.create({
    ...(PROVIDER_ROUTING as object),
    model: env.FAST_MODEL,
    max_tokens: 200,
    system: CLARIFY_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 300) : null;
}
