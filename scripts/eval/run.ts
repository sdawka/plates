// Runs the labelled cases against a decision model through the real `decide()` client and the real
// question builders, recording the raw answers (probabilities trimmed) before any threshold is applied.
import { decide, type Answers, type Question } from "../../src/decide.ts";
import { LlmPermanentError } from "../../src/llm.ts";
import type { Env } from "../../src/types.ts";
import { DECIDE_FAMILIES, intentQuestions, isAskQuestions, reactionQuestions, type Cases, type Family } from "./cases.ts";
import type { Raw, RunRecord } from "./score.ts";

export interface RunOptions {
  env: Env;
  families: Family[];
  only?: string;
  concurrency: number;
  /** Called before each case; the oracle scripts the fake here. */
  before?: (family: Family, id: string) => void;
  onProgress?: (done: number, total: number, rec: RunRecord) => void;
}

const KEEP_PROBS = 5;
const RETRIES = 3;

/** Keep the top few probabilities plus the chosen one; enough to rescore and to read. */
function trim(answers: Answers<Record<string, Question>>): Raw {
  const out: Raw = {};
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === "noul") out[id] = { type: "noul", noul: round(a.noul) };
    else {
      const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, KEEP_PROBS);
      const chosen = a.type === "choice" ? a.choice : null;
      if (chosen !== null && !top.some(([k]) => k === chosen)) top.push([chosen, a.probabilities[chosen] ?? 0]);
      const probabilities = Object.fromEntries(top.map(([k, v]) => [k, round(v)]));
      out[id] = a.type === "choice" ? { type: "choice", choice: a.choice, confidence: round(a.confidence), probabilities } : { type: "score", score: a.score, confidence: round(a.confidence), probabilities };
    }
  }
  return out;
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function one(opts: RunOptions, family: Family, id: string, req: { state: unknown; questions: Record<string, Question> }): Promise<RunRecord> {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      opts.before?.(family, id);
      const answers = await decide(opts.env, req);
      return { id, family, raw: trim(answers), ms: Date.now() - started };
    } catch (e) {
      const permanent = e instanceof LlmPermanentError;
      if (permanent || attempt >= RETRIES) return { id, family, error: `${permanent ? "permanent" : "transient"}: ${(e as Error).message}`, ms: Date.now() - started };
      await sleep(500 * 2 ** attempt);
    }
  }
}

export async function runCases(cases: Cases, opts: RunOptions): Promise<RunRecord[]> {
  const jobs: { family: Family; id: string; req: { state: unknown; questions: Record<string, Question> } }[] = [];
  const want = (f: Family) => opts.families.includes(f) && DECIDE_FAMILIES.includes(f);
  const pick = (id: string) => !opts.only || id.startsWith(opts.only);
  if (want("intent")) for (const c of cases.intent) if (pick(c.id)) jobs.push({ family: "intent", id: c.id, req: intentQuestions(c) });
  if (want("is_ask")) for (const c of cases.is_ask) if (pick(c.id)) jobs.push({ family: "is_ask", id: c.id, req: isAskQuestions(c) });
  if (want("reaction")) for (const c of cases.reaction) if (pick(c.id)) jobs.push({ family: "reaction", id: c.id, req: reactionQuestions(c) });

  const records: RunRecord[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const rec = await one(opts, job.family, job.id, job.req);
      records.push(rec);
      opts.onProgress?.(records.length, jobs.length, rec);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return records.sort((a, b) => a.id.localeCompare(b.id));
}
