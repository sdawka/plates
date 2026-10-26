// System One client: typed multiple-choice / score / yes-no questions answered with probabilities,
// in place of free-form JSON with a self-reported confidence.
// https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request.md
// https://docs.typesafe.ai/api.md
//
// One attempt per call. Rate limits and server errors throw a plain Error (the queue retries);
// anything the same request would fail with again throws LlmPermanentError.

import { LlmPermanentError } from "./llm";
import { info } from "./log";
import type { Env } from "./types";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Up to 255 options; the value describes the option. */
  criteria: Record<string, string | null>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** 2 to 10 levels, lowest first. */
  criteria: string[];
}
export interface NoulQuestion {
  type: "noul";
  /** A statement; the answer is how likely it is true. */
  instructions: string;
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface NoulAnswer {
  type: "noul";
  /** Probability the statement is true. */
  noul: number;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

type AnswerOf<Q extends Question> = Q extends ChoiceQuestion ? ChoiceAnswer : Q extends ScoreQuestion ? ScoreAnswer : NoulAnswer;
export type Answers<Qs extends Record<string, Question>> = { [K in keyof Qs]: AnswerOf<Qs[K]> };

export interface DecideRequest<Qs extends Record<string, Question>> {
  /** What the questions are about: a string, object or array. Keep it compact (64k tokens per request, 32k per question). */
  state: unknown;
  questions: Qs;
  sessionId?: string;
}

/** Probability of the answer's top outcome. Gate on this, not on `confidence`, which is rescaled by the option count. */
export function pMax(a: ChoiceAnswer | ScoreAnswer): number {
  return a.type === "choice" ? (a.probabilities[a.choice] ?? 0) : Math.max(0, ...Object.values(a.probabilities));
}

/** Question ids may only use letters, digits, `_`, `.` and `-`. */
export const QUESTION_ID = /^[A-Za-z0-9_.-]+$/;

/**
 * The two OpenRouter endpoints that take this request shape, relative to LLM_BASE_URL (which ends in `/api`):
 * the TypeSafe-compatible System One route, and OpenRouter's own Decisions route that fronts every decision model.
 * https://openrouter.ai/docs/api/api-reference/decisions
 */
export const DECIDE_PATHS = { systemone: "/v1/systemone", decisions: "/alpha/decisions" } as const;

export function decidePath(env: Pick<Env, "DECIDE_API">): string {
  const api = env.DECIDE_API ?? "systemone";
  const path = (DECIDE_PATHS as Record<string, string>)[api];
  if (!path) throw new LlmPermanentError(`DECIDE_API: unknown value ${JSON.stringify(api)} (expected "systemone" or "decisions")`);
  return path;
}

export async function decide<Qs extends Record<string, Question>>(env: Env, req: DecideRequest<Qs>): Promise<Answers<Qs>> {
  const started = Date.now();
  const path = decidePath(env);
  const res = await fetch(`${env.LLM_BASE_URL ?? "https://openrouter.ai/api"}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.PUBLIC_URL ?? "https://plates.webisoft.workers.dev",
      "X-OpenRouter-Title": "Plates",
    },
    body: JSON.stringify({
      model: env.DECIDE_MODEL,
      ...(req.sessionId && { session_id: req.sessionId }),
      state: req.state,
      questions: req.questions,
    }),
  });
  info("systemone call", { questions: Object.keys(req.questions), api: env.DECIDE_API ?? "systemone", status: res.status, ms: Date.now() - started });
  const body = (await res.json().catch(() => null)) as { answers?: Record<string, unknown>; error?: { code?: unknown; message?: string } } | null;
  if (!res.ok) {
    const msg = `systemone ${res.status}: ${body?.error?.message ?? res.statusText}`;
    if (res.status === 429 || res.status >= 500) throw new Error(msg);
    throw new LlmPermanentError(msg);
  }
  // OpenRouter reports errors that happen after routing as HTTP 200 with an error body.
  if (body?.error) throw new Error(`systemone: ${body.error.message ?? "error"}`);
  const answers = body?.answers ?? {};
  for (const [id, q] of Object.entries(req.questions)) {
    const a = answers[id] as { type?: unknown } | undefined;
    if (!a || a.type !== q.type) throw new Error(`systemone: no ${q.type} answer for "${id}"`); // transient: retry
  }
  return answers as unknown as Answers<Qs>;
}
