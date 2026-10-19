// Shared Claude tool call with stop_reason handling.
// https://platform.claude.com/docs/en/docs/build-with-claude/handling-stop-reasons
//
// tool_choice stays "auto": Opus 5.5, Sonnet 5.5 and Fable 5.1 answer forced tool use with a 400.
// Tools are strict, so when the model calls one its input matches the schema; the system prompt
// and a closing instruction ask it to always call the tool.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use#forcing-tool-use

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./types";

/** Not worth retrying: the model refused, or the output can't fit even with the larger budget. */
export class LlmPermanentError extends Error {}

export interface ToolCall {
  model: string;
  maxTokens: number;
  /** Retried once with this budget when the first answer is cut off at max_tokens. */
  retryMaxTokens: number;
  system: string;
  tool: Anthropic.Tool;
  prompt: string;
}

export async function callTool(env: Env, call: ToolCall): Promise<unknown> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });
  for (const maxTokens of [call.maxTokens, call.retryMaxTokens]) {
    const res = await client.messages.create({
      model: call.model,
      max_tokens: maxTokens,
      system: call.system,
      tools: [call.tool],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: `${call.prompt}\n\nAnswer by calling the ${call.tool.name} tool.` }],
    });
    if (res.stop_reason === "refusal") throw new LlmPermanentError(`${call.tool.name}: refusal`);
    if (res.stop_reason === "max_tokens") continue; // tool input is incomplete; try the larger budget
    const block = res.content.find((b) => b.type === "tool_use" && b.name === call.tool.name);
    if (!block || block.type !== "tool_use") throw new Error(`${call.tool.name}: no tool_use block`); // transient: retry
    return block.input;
  }
  throw new LlmPermanentError(`${call.tool.name}: output truncated at ${call.retryMaxTokens} tokens`);
}
