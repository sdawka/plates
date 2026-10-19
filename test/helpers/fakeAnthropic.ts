// Fake Anthropic Messages API (POST /v1/messages), shaped after the Messages and tool-use docs.
// Requests are validated like the real API (headers, model, max_tokens, messages, tools, tool_choice)
// and answered from per-tool FIFO queues scripted by the test.
import { json, type Network } from "./net";

type Obj = Record<string, unknown>;

export const ANTHROPIC_URL = "https://anthropic.test";
export const ANTHROPIC_KEY = "sk-ant-test-key";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface RecordedAnthropicRequest {
  headers: Record<string, string>;
  body: Obj;
  model: string;
  system: string;
  /** Plain text of the last user message. */
  prompt: string;
  toolNames: string[];
  forcedTool: string | null;
  /** What was returned: tool name, "text", or "error". */
  answeredWith: string;
}

type Scripted =
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "text"; text: string; model?: string }
  | { kind: "error"; status: number; type: string; message: string };

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error",
  413: "request_too_large", 429: "rate_limit_error", 500: "api_error", 529: "overloaded_error",
};

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const bad = (message: string) => new ApiError(400, message);

export class FakeAnthropic {
  readonly requests: RecordedAnthropicRequest[] = [];
  /** Requests nobody scripted an answer for (also answered with a 400 so the SUT fails loudly). */
  readonly unscripted: RecordedAnthropicRequest[] = [];
  private toolQueues = new Map<string, Scripted[]>();
  private textQueue: Scripted[] = [];
  private errorQueue: Scripted[] = [];
  private n = 0;

  /**
   * Documented (tool use > "Forcing tool use"): Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 answer a 400 to
   * tool_choice any/tool; Haiku 5.5 accepts it.
   */
  rejectForcedToolOnNewModels = true;

  /**
   * Documented (structured outputs > JSON Schema limitations): strict tools reject minimum/maximum/minLength/
   * maxLength/maxItems, minItems above 1, and objects without additionalProperties:false with a 400.
   */
  rejectUnsupportedStrictSchema = true;

  constructor(readonly apiKey = ANTHROPIC_KEY) {}

  attach(net: Network): void {
    net.route(`${ANTHROPIC_URL}/v1/messages`, (req) => this.handle(req));
  }

  /** Script the next tool_use for `name` (FIFO). `input` is checked against the tool's input_schema when answered. */
  queueToolUse(name: string, input: unknown): this {
    const q = this.toolQueues.get(name) ?? [];
    q.push({ kind: "tool", name, input });
    this.toolQueues.set(name, q);
    return this;
  }

  /** Script the next plain text answer (a request without forced tool use). */
  queueText(text: string, opts: { model?: string } = {}): this {
    this.textQueue.push({ kind: "text", text, ...opts });
    return this;
  }

  /** Fail the next request (any kind) with an HTTP error, e.g. 529 overloaded. */
  failNext(status: number, message = "scripted failure"): this {
    this.errorQueue.push({ kind: "error", status, type: ERROR_TYPES[status] ?? "api_error", message });
    return this;
  }

  pending(): number {
    return [...this.toolQueues.values()].reduce((n, q) => n + q.length, 0) + this.textQueue.length;
  }

  callsFor(toolName: string): RecordedAnthropicRequest[] {
    return this.requests.filter((r) => r.toolNames.includes(toolName));
  }

  // ---------- request handling ----------

  private async handle(req: Request): Promise<Response> {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    let body: Obj = {};
    try {
      if (req.method !== "POST") throw new ApiError(405, "method not allowed");
      if (!headers["x-api-key"]) throw new ApiError(401, "x-api-key header is required");
      if (headers["x-api-key"] !== this.apiKey) throw new ApiError(401, "invalid x-api-key");
      if (headers["anthropic-version"] !== ANTHROPIC_VERSION) throw bad("anthropic-version header is required (2023-06-01)");
      if (!(headers["content-type"] ?? "").startsWith("application/json")) throw bad("Content-Type must be application/json");
      try {
        body = JSON.parse(await req.text()) as Obj;
      } catch {
        throw bad("Request body is not valid JSON");
      }
      const rec = this.validate(body, headers);
      return this.answer(rec);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const rec = this.record(body, headers, "error");
      this.requests.push(rec);
      return json({ type: "error", error: { type: ERROR_TYPES[e.status] ?? "api_error", message: e.message } }, e.status, { "request-id": `req_${++this.n}` });
    }
  }

  private record(body: Obj, headers: Record<string, string>, answeredWith: string): RecordedAnthropicRequest {
    const tools = Array.isArray(body.tools) ? (body.tools as Obj[]) : [];
    const choice = body.tool_choice as Obj | undefined;
    return {
      headers,
      body,
      model: String(body.model ?? ""),
      system: typeof body.system === "string" ? body.system : Array.isArray(body.system) ? (body.system as Obj[]).map((b) => String(b.text ?? "")).join("\n") : "",
      prompt: lastUserText(body),
      toolNames: tools.map((t) => String(t.name)),
      forcedTool: choice?.type === "tool" ? String(choice.name) : null,
      answeredWith,
    };
  }

  private validate(b: Obj, headers: Record<string, string>): RecordedAnthropicRequest {
    if (typeof b.model !== "string" || !/^claude-[a-z0-9.-]+$/.test(b.model)) throw bad("model: must be a valid Claude model id");
    if (!Number.isInteger(b.max_tokens) || (b.max_tokens as number) < 1) throw bad("max_tokens: Field required (positive integer)");
    if (b.stream === true) throw bad("FakeAnthropic does not implement streaming");
    if (!Array.isArray(b.messages) || b.messages.length === 0) throw bad("messages: at least one message is required");
    (b.messages as Obj[]).forEach((m, i) => {
      if (m.role !== "user" && m.role !== "assistant") throw bad(`messages.${i}.role: must be "user" or "assistant"`);
      const c = m.content;
      if (typeof c === "string") {
        if (c.trim() === "") throw bad(`messages.${i}: text content blocks must be non-empty`);
      } else if (Array.isArray(c) && c.length > 0) {
        for (const blk of c as Obj[]) if (typeof blk.type !== "string") throw bad(`messages.${i}.content: block type required`);
      } else throw bad(`messages.${i}.content: must be a non-empty string or array of blocks`);
    });
    if ((b.messages as Obj[])[0]!.role !== "user") throw bad("messages: first message must use the user role");
    if (b.system !== undefined && typeof b.system !== "string" && !Array.isArray(b.system)) throw bad("system: must be a string or array of text blocks");

    let toolNames: string[] = [];
    if (b.tools !== undefined) {
      if (!Array.isArray(b.tools)) throw bad("tools: must be an array");
      toolNames = (b.tools as Obj[]).map((t, i) => {
        if (typeof t.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw bad(`tools.${i}.name: must match ^[a-zA-Z0-9_-]{1,64}$`);
        const schema = t.input_schema as Obj | undefined;
        if (!schema || schema.type !== "object") throw bad(`tools.${i}.input_schema: type must be "object"`);
        if (t.description !== undefined && typeof t.description !== "string") throw bad(`tools.${i}.description: must be a string`);
        if (t.strict === true && this.rejectUnsupportedStrictSchema) {
          const problems = strictSchemaProblems(schema, `tools.${i}.input_schema`);
          if (problems.length) throw bad(`tools.${i}: strict tool schema not supported:\n${problems.join("\n")}`);
        }
        return t.name;
      });
      if (new Set(toolNames).size !== toolNames.length) throw bad("tools: tool names must be unique");
    }
    const choice = b.tool_choice as Obj | undefined;
    if (choice !== undefined) {
      if (!b.tools) throw bad("tool_choice: tools must be provided when tool_choice is set");
      if (!["auto", "any", "tool", "none"].includes(String(choice.type))) throw bad("tool_choice.type: must be auto, any, tool or none");
      if (choice.type === "tool" && !toolNames.includes(String(choice.name))) throw bad(`tool_choice.name: no tool named "${String(choice.name)}" in tools`);
      if (this.rejectForcedToolOnNewModels && (choice.type === "tool" || choice.type === "any") && /^claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)/.test(String(b.model)))
        throw bad(`tool_choice: forced tool use (type "${String(choice.type)}") is not supported by model ${String(b.model)}; use "auto" or "none"`);
    }
    return this.record(b, headers, "pending");
  }

  private answer(rec: RecordedAnthropicRequest): Response {
    const fail = this.errorQueue.shift();
    if (fail && fail.kind === "error") {
      rec.answeredWith = "error";
      this.requests.push(rec);
      return json({ type: "error", error: { type: fail.type, message: fail.message } }, fail.status, { "request-id": `req_${++this.n}` });
    }

    const body = rec.body;
    const choice = body.tool_choice as Obj | undefined;
    const tools = Array.isArray(body.tools) ? (body.tools as Obj[]) : [];
    let scripted: Scripted | undefined;
    if (rec.forcedTool) scripted = this.toolQueues.get(rec.forcedTool)?.shift();
    else if (tools.length > 0 && choice?.type !== "none") {
      const name = rec.toolNames.find((n) => (this.toolQueues.get(n)?.length ?? 0) > 0);
      scripted = name ? this.toolQueues.get(name)!.shift() : this.takeText(rec.model);
    } else scripted = this.takeText(rec.model);

    if (!scripted) {
      rec.answeredWith = "unscripted";
      this.requests.push(rec);
      this.unscripted.push(rec);
      return json(
        { type: "error", error: { type: "invalid_request_error", message: `FakeAnthropic: nothing scripted for model=${rec.model} tools=[${rec.toolNames}] forced=${rec.forcedTool}` } },
        400,
        { "request-id": `req_${++this.n}` },
      );
    }

    let content: Obj[];
    let stop_reason: string;
    if (scripted.kind === "tool") {
      const tool = tools.find((t) => t.name === scripted.name);
      if (!tool) throw new Error(`FakeAnthropic: scripted tool "${scripted.name}" was not offered (offered: ${rec.toolNames})`);
      const problems = checkSchema(scripted.input, tool.input_schema as Obj, "input");
      if (problems.length) throw new Error(`FakeAnthropic: scripted input for ${scripted.name} violates its input_schema:\n${problems.join("\n")}`);
      content = [{ type: "tool_use", id: `toolu_${String(++this.n).padStart(24, "0")}`, name: scripted.name, input: scripted.input }];
      stop_reason = "tool_use";
      rec.answeredWith = scripted.name;
    } else if (scripted.kind === "text") {
      content = [{ type: "text", text: scripted.text }];
      stop_reason = "end_turn";
      rec.answeredWith = "text";
    } else {
      throw new Error("unreachable");
    }
    this.requests.push(rec);
    const inTokens = Math.ceil(JSON.stringify(body.messages).length / 4);
    return json(
      {
        id: `msg_${String(++this.n).padStart(24, "0")}`,
        type: "message",
        role: "assistant",
        model: rec.model,
        content,
        stop_reason,
        stop_sequence: null,
        usage: { input_tokens: inTokens, output_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      200,
      { "request-id": `req_${++this.n}` },
    );
  }

  private takeText(model: string): Scripted | undefined {
    const i = this.textQueue.findIndex((s) => s.kind === "text" && (!s.model || s.model === model));
    return i >= 0 ? this.textQueue.splice(i, 1)[0] : undefined;
  }
}

function lastUserText(body: Obj): string {
  const msgs = (body.messages as Obj[] | undefined) ?? [];
  const last = [...msgs].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return ((last.content as Obj[]) ?? []).map((b) => String(b.text ?? "")).join("\n");
}

const STRICT_BANNED = ["minimum", "maximum", "minLength", "maxLength", "maxItems"];

/** Schema features the structured-outputs docs reject for strict tools. */
export function strictSchemaProblems(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Obj;
  const out: string[] = [];
  for (const k of STRICT_BANNED) if (k in s) out.push(`${path}: "${k}" is not supported`);
  if (typeof s.minItems === "number" && s.minItems > 1) out.push(`${path}: minItems above 1 is not supported`);
  if (s.type === "object" && s.additionalProperties !== false) out.push(`${path}: object needs additionalProperties:false`);
  for (const [k, v] of Object.entries((s.properties as Obj | undefined) ?? {})) out.push(...strictSchemaProblems(v, `${path}.properties.${k}`));
  if (s.items) out.push(...strictSchemaProblems(s.items, `${path}.items`));
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(s[k])) (s[k] as unknown[]).forEach((v, i) => out.push(...strictSchemaProblems(v, `${path}.${k}[${i}]`)));
  for (const k of ["$defs", "definitions"]) for (const [n, v] of Object.entries((s[k] as Obj | undefined) ?? {})) out.push(...strictSchemaProblems(v, `${path}.${k}.${n}`));
  return out;
}

/** Small JSON Schema subset check (type, enum, required, properties, items) for scripted tool inputs. */
export function checkSchema(value: unknown, schema: Obj, path: string): string[] {
  const out: string[] = [];
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  if (types) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Obj;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in o)) out.push(`${path}.${r}: required`);
    for (const [k, sub] of Object.entries((schema.properties as Record<string, Obj> | undefined) ?? {})) {
      if (k in o) out.push(...checkSchema(o[k], sub, `${path}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => out.push(...checkSchema(v, schema.items as Obj, `${path}[${i}]`)));
  return out;
}
