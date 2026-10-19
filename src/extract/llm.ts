// Claude calls. Throws on transient failures (the queue retries); returns raw tool input otherwise.

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";
import { CLARIFY_SYSTEM, EXTRACT_SYSTEM, EXTRACT_TOOL, EXTRACT_TOOL_NAME } from "./prompt";

const client = (env: Env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/** Run the extraction tool call and return the tool input (unvalidated). */
export async function callExtraction(env: Env, prompt: string): Promise<unknown> {
  const res = await client(env).messages.create({
    model: env.EXTRACT_MODEL,
    max_tokens: 4096,
    system: EXTRACT_SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: EXTRACT_TOOL_NAME },
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content.find((b) => b.type === "tool_use" && b.name === EXTRACT_TOOL_NAME);
  if (!block || block.type !== "tool_use") throw new Error("extraction: model returned no tool_use block");
  return block.input;
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
