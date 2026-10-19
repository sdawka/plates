// Fake System One endpoint (POST /v1/systemone), shaped after
// https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request.md and
// https://docs.typesafe.ai/api.md. Requests are validated like the real API (auth, model, question ids and
// types, choice criteria and the 255-option limit) and answered from per-question-id FIFO queues scripted by
// the test. A request asking a question nobody scripted gets a 400, so the SUT fails loudly.
import { json, type Network } from "./net";

type Obj = Record<string, unknown>;

export const SYSTEMONE_PATH = "/v1/systemone";
export const SYSTEMONE_KEY = "sk-ant-test-key"; // the OpenRouter key the harness uses everywhere
const MAX_OPTIONS = 255;
const ID_RE = /^[A-Za-z0-9_.-]+$/;

export interface RecordedSystemOneRequest {
  headers: Record<string, string>;
  body: Obj;
  model: string;
  state: unknown;
  questions: Record<string, Obj>;
  /** Question ids answered, or "error". */
  answeredWith: string[] | "error";
}

type Scripted = { type: "choice"; choice: string; p: number } | { type: "noul"; p: number } | { type: "score"; level: number; p: number };

const ERROR_CODES: Record<number, string> = {
  400: "invalid_request", 401: "unauthorized", 402: "insufficient_credits", 422: "unprocessable", 429: "rate_limited",
  502: "bad_gateway", 503: "unavailable", 524: "timeout", 529: "overloaded",
};

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const bad = (message: string) => new ApiError(400, message);

export class FakeSystemOne {
  readonly requests: RecordedSystemOneRequest[] = [];
  /** Requests with a question nobody scripted (also answered with a 400). */
  readonly unscripted: RecordedSystemOneRequest[] = [];
  private queues = new Map<string, Scripted[]>();
  private standing = new Map<string, Scripted>();
  private errors: { status: number; message: string }[] = [];
  private n = 0;

  constructor(readonly apiKey = SYSTEMONE_KEY, readonly modelPattern = /^typesafe\/jev-[0-9.]+/) {}

  attach(net: Network, baseUrl: string): void {
    net.route(`${baseUrl}${SYSTEMONE_PATH}`, (req) => this.handle(req));
  }

  private push(id: string, s: Scripted): this {
    this.queues.set(id, [...(this.queues.get(id) ?? []), s]);
    return this;
  }

  /** Script the next answer to a choice question: `choice` gets probability `p`, the other options share the rest. */
  queueChoice(id: string, choice: string, p = 0.95): this {
    return this.push(id, { type: "choice", choice, p });
  }

  /** Script the next answer to a yes/no question: the probability that the statement is true. */
  queueNoul(id: string, p: number): this {
    return this.push(id, { type: "noul", p });
  }

  /** Script the next answer to a score question: index of the top level and its probability. */
  queueScore(id: string, level: number, p = 0.9): this {
    return this.push(id, { type: "score", level, p });
  }

  /** Answer a choice question with this whenever nothing is queued for it (for questions a test doesn't care about). */
  alwaysChoice(id: string, choice: string, p = 0.95): this {
    this.standing.set(id, { type: "choice", choice, p });
    return this;
  }

  /** Like alwaysChoice, for a yes/no question. */
  alwaysNoul(id: string, p: number): this {
    this.standing.set(id, { type: "noul", p });
    return this;
  }

  /** Fail the next request with an HTTP error, e.g. 429 or 402. */
  failNext(status: number, message = "scripted failure"): this {
    this.errors.push({ status, message });
    return this;
  }

  /** Scripted answers nobody has asked for yet. */
  pending(): number {
    return [...this.queues.values()].reduce((n, q) => n + q.length, 0);
  }

  callsFor(questionId: string): RecordedSystemOneRequest[] {
    return this.requests.filter((r) => questionId in r.questions);
  }

  // ---------- request handling ----------

  private async handle(req: Request): Promise<Response> {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    let body: Obj = {};
    try {
      if (req.method !== "POST") throw new ApiError(405, "method not allowed");
      const key = headers["authorization"]?.replace(/^Bearer /, "");
      if (!key) throw new ApiError(401, "Authorization: Bearer header is required");
      if (key !== this.apiKey) throw new ApiError(401, "invalid API key");
      if (!(headers["content-type"] ?? "").startsWith("application/json")) throw bad("Content-Type must be application/json");
      try {
        body = JSON.parse(await req.text()) as Obj;
      } catch {
        throw bad("Request body is not valid JSON");
      }
      const injected = this.errors.shift();
      if (injected) throw new ApiError(injected.status, injected.message);
      const rec = this.validate(body, headers);
      return this.answer(rec);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      this.requests.push(this.record(body, headers, "error"));
      return this.fail(e.status, e.message);
    }
  }

  private fail(status: number, message: string): Response {
    return json({ error: { code: ERROR_CODES[status] ?? "error", message } }, status);
  }

  private record(body: Obj, headers: Record<string, string>, answeredWith: RecordedSystemOneRequest["answeredWith"]): RecordedSystemOneRequest {
    const q = body.questions && typeof body.questions === "object" && !Array.isArray(body.questions) ? (body.questions as Record<string, Obj>) : {};
    return { headers, body, model: String(body.model ?? ""), state: body.state, questions: q, answeredWith };
  }

  private validate(b: Obj, headers: Record<string, string>): RecordedSystemOneRequest {
    if (typeof b.model !== "string" || !this.modelPattern.test(b.model)) throw bad(`model: unknown model ${JSON.stringify(b.model)}`);
    if (b.session_id !== undefined && typeof b.session_id !== "string") throw bad("session_id: must be a string");
    if (b.state === undefined || b.state === null) throw bad("state: Field required (string, object or array)");
    if (typeof b.state !== "string" && typeof b.state !== "object") throw bad("state: must be a string, object or array");
    const qs = b.questions;
    if (!qs || typeof qs !== "object" || Array.isArray(qs) || Object.keys(qs).length === 0) throw bad("questions: at least one question is required");
    for (const [id, raw] of Object.entries(qs as Record<string, Obj>)) {
      if (!ID_RE.test(id)) throw bad(`questions.${id}: ids may only use letters, digits, "_", "." and "-"`);
      const q = raw as Obj | null;
      if (!q || typeof q !== "object") throw bad(`questions.${id}: must be an object`);
      if (typeof q.instructions !== "string" || !q.instructions.trim()) throw bad(`questions.${id}.instructions: Field required`);
      switch (q.type) {
        case "choice": {
          const c = q.criteria;
          if (!c || typeof c !== "object" || Array.isArray(c)) throw bad(`questions.${id}.criteria: choice questions need criteria (an object of option -> description | null)`);
          const options = Object.entries(c as Obj);
          if (options.length < 2) throw bad(`questions.${id}.criteria: at least 2 options are required`);
          if (options.length > MAX_OPTIONS) throw bad(`questions.${id}.criteria: at most ${MAX_OPTIONS} options (got ${options.length})`);
          for (const [k, v] of options) {
            if (!k) throw bad(`questions.${id}.criteria: option keys must be non-empty`);
            if (v !== null && typeof v !== "string") throw bad(`questions.${id}.criteria.${k}: must be a string or null`);
          }
          break;
        }
        case "score": {
          const c = q.criteria;
          if (!Array.isArray(c) || c.length < 2 || c.length > 10 || c.some((x) => typeof x !== "string")) throw bad(`questions.${id}.criteria: score questions need 2 to 10 level descriptions`);
          break;
        }
        case "noul":
          break;
        default:
          throw bad(`questions.${id}.type: must be choice, score or noul`);
      }
    }
    return this.record(b, headers, []);
  }

  private answer(rec: RecordedSystemOneRequest): Response {
    const missing = Object.keys(rec.questions).filter((id) => !this.queues.get(id)?.length && !this.standing.has(id));
    if (missing.length) {
      rec.answeredWith = "error";
      this.requests.push(rec);
      this.unscripted.push(rec);
      return this.fail(400, `FakeSystemOne: nothing scripted for question(s) ${missing.join(", ")}`);
    }

    const answers: Obj = {};
    for (const [id, q] of Object.entries(rec.questions)) {
      const s = this.queues.get(id)?.shift() ?? this.standing.get(id)!;
      if (s.type !== q.type) throw new Error(`FakeSystemOne: scripted ${s.type} answer for "${id}" but the request asks a ${String(q.type)} question`);
      if (s.type === "choice") {
        const options = Object.keys(q.criteria as Obj);
        if (!options.includes(s.choice)) throw new Error(`FakeSystemOne: scripted choice ${JSON.stringify(s.choice)} for "${id}" is not one of its options (${options.join(", ")})`);
        const rest = options.filter((o) => o !== s.choice);
        const probabilities = Object.fromEntries([[s.choice, s.p], ...rest.map((o) => [o, (1 - s.p) / rest.length])]);
        const n = options.length;
        answers[id] = { type: "choice", choice: s.choice, confidence: (s.p - 1 / n) / (1 - 1 / n), probabilities };
      } else if (s.type === "noul") {
        answers[id] = { type: "noul", noul: s.p };
      } else {
        const levels = (q.criteria as string[]).length;
        if (s.level < 0 || s.level >= levels) throw new Error(`FakeSystemOne: scripted score level ${s.level} out of range for "${id}"`);
        const rest = (1 - s.p) / (levels - 1);
        const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === s.level ? s.p : rest]));
        answers[id] = { type: "score", score: s.level / (levels - 1), confidence: (s.p - 1 / levels) / (1 - 1 / levels), probabilities };
      }
    }
    rec.answeredWith = Object.keys(answers);
    this.requests.push(rec);
    return json({
      id: `gen-dec-${String(++this.n).padStart(12, "0")}`,
      model: `${rec.model}-fake`,
      provider: "TypeSafe",
      answers,
      usage: { input_tokens: Math.ceil(JSON.stringify(rec.body.state).length / 4), output_tokens: 20, cost: 0.00003 },
    });
  }
}
