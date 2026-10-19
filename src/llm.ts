// Shared Claude tool call with stop_reason handling.
// https://platform.claude.com/docs/en/docs/build-with-claude/handling-stop-reasons
//
// tool_choice stays "auto": Opus 5.5, Sonnet 5.5 and Fable 5.1 answer forced tool use with a 400.
// Tools are strict, so when the model calls one its input matches the schema; the system prompt
// and a closing instruction ask it to always call the tool.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use#forcing-tool-use

import { info } from "./log";
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

/**
 * Claude through OpenRouter's Anthropic-compatible Messages endpoint, so stop_reason, strict tools
 * and content blocks behave as in Anthropic's own API. OpenRouter authenticates with a bearer token.
 * https://openrouter.ai/docs/api/reference/overview
 */
export function llmClient(env: Env): Anthropic {
  return new Anthropic({
    baseURL: env.LLM_BASE_URL ?? "https://openrouter.ai/api",
    apiKey: null,
    authToken: env.OPENROUTER_API_KEY,
    defaultHeaders: { "HTTP-Referer": env.PUBLIC_URL ?? "https://plates.webisoft.workers.dev", "X-OpenRouter-Title": "Plates" },
  });
}

/**
 * OpenRouter routing: only providers that honour every parameter we send (it otherwise drops unsupported
 * ones silently), and not Claude in Amazon Bedrock, which lacks structured outputs / strict tools.
 */
export const PROVIDER_ROUTING = { provider: { require_parameters: true, ignore: ["amazon-bedrock", "claude-on-aws"] } };

export async function callTool(env: Env, call: ToolCall): Promise<unknown> {
  const client = llmClient(env);
  for (const maxTokens of [call.maxTokens, call.retryMaxTokens]) {
    const started = Date.now();
    const res = await client.messages.create({
      ...(PROVIDER_ROUTING as object),
      model: call.model,
      max_tokens: maxTokens,
      system: call.system,
      tools: [call.tool],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: `${call.prompt}\n\nAnswer by calling the ${call.tool.name} tool.` }],
    });
    info("llm call", { tool: call.tool.name, model: call.model, ms: Date.now() - started, stop: res.stop_reason, in: res.usage?.input_tokens, out: res.usage?.output_tokens });
    if (res.stop_reason === "refusal") throw new LlmPermanentError(`${call.tool.name}: refusal`);
    if (res.stop_reason === "max_tokens") continue; // tool input is incomplete; try the larger budget
    const block = res.content.find((b) => b.type === "tool_use" && b.name === call.tool.name);
    if (!block || block.type !== "tool_use") throw new Error(`${call.tool.name}: no tool_use block`); // transient: retry
    return block.input;
  }
  throw new LlmPermanentError(`${call.tool.name}: output truncated at ${call.retryMaxTokens} tokens`);
}
