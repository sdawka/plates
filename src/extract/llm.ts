// Claude calls. Throws on transient failures (the queue retries); returns raw tool input otherwise.

import Anthropic from "@anthropic-ai/sdk";
import { callTool } from "../llm";
import type { Env } from "../types";
import { CLARIFY_SYSTEM, EXTRACT_SYSTEM, EXTRACT_TOOL, EXTRACT_TOOL_NAME } from "./prompt";

const client = (env: Env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });

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
  const res = await client(env).messages.create({
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
