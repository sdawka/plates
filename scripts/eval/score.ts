// Scoring of recorded decision-model answers against the labels. Pure. The intent outcome is computed with
// the production reducer and validator (`reduceIntentAnswers` + `validateDecision`), so the eval judges
// exactly what Plates would do with the same answers at the given thresholds.

import { pMax, type Answers, type Question } from "../../src/decide";
import { reduceIntentAnswers } from "../../src/intent/questions";
import { validateDecision, type ValidateInput } from "../../src/intent/validate";
import type { Thresholds } from "../../src/thresholds";
import { BOT_USER_ID, intentInput, intentQuestions, type Cases, type Family, type IntentCase, type IsAskCase, type Outcome3, type ReactionCase } from "./cases";

export type Raw = Answers<Record<string, Question>>;

export interface RunRecord {
  id: string;
  family: Family;
  /** The model's answers (probabilities trimmed to the top few); absent on error. */
  raw?: Raw;
  error?: string;
  ms: number;
}

export interface ResultsMeta {
  model: string;
  api: string;
  git_sha: string;
  ran_at: string;
  cases_sha256: Record<string, string>;
  thresholds_used: Thresholds;
}

export interface ResultsFile {
  meta: ResultsMeta;
  records: RunRecord[];
}

// ---------- per-case evaluation ----------

export interface IntentEval {
  outcome: Outcome3;
  choice: string;
  p: number;
  deadline: string | null;
  ambiguous: number;
  delivers: Record<string, number>;
}

export function evalIntent(c: IntentCase, raw: Raw, T: Thresholds): IntentEval {
  const i = intentInput(c);
  const d = reduceIntentAnswers(raw, i, T.DEADLINE_P);
  const input: ValidateInput = { ...i, decision: d, botUserId: BOT_USER_ID, thresholds: T };
  const o = validateDecision(input);
  return { outcome: o.kind === "none" ? "none" : o.auto ? "auto" : "propose", choice: d.choice, p: d.p, deadline: d.deadline, ambiguous: d.ambiguous, delivers: d.delivers };
}

export const isAskP = (raw: Raw): number => (raw.is_ask?.type === "noul" ? raw.is_ask.noul : 0);

export function evalReaction(raw: Raw, min: number): { meaning: "yes" | "no" | "unclear"; top: string; p: number } {
  const a = raw.meaning;
  if (a?.type !== "choice") return { meaning: "unclear", top: "?", p: 0 };
  const p = pMax(a);
  const meaning = (a.choice === "yes" || a.choice === "no") && p >= min ? a.choice : "unclear";
  return { meaning, top: a.choice, p };
}

export const kindOf = (choice: string): string => (choice === "none" ? "none" : choice.slice(choice.indexOf(":") + 1));

// ---------- metrics ----------

export type Confusion = Record<string, Record<string, number>>;

export function bump(m: Confusion, label: string, pred: string): void {
  (m[label] ??= {})[pred] = (m[label]![pred] ?? 0) + 1;
}

export interface PR {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export function pr(tp: number, fp: number, fn: number): PR {
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

export interface SweepRow {
  x: number;
  pr: PR;
  current: boolean;
  best: boolean;
}

export const GRID = Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100); // 0.05 … 0.95

/**
 * Vary one threshold over GRID, the others fixed at T. An item is a hit when it is predicted positive and
 * correct; precision = hits / predicted, recall = hits / labelled positive.
 */
export function sweep<I>(
  name: keyof Thresholds,
  T: Thresholds,
  items: I[],
  positive: (item: I) => boolean,
  predict: (item: I, T: Thresholds) => { predicted: boolean; correct: boolean },
): SweepRow[] {
  const rows = GRID.map((x) => {
    const Tx = { ...T, [name]: x };
    let tp = 0, fp = 0, fn = 0;
    for (const item of items) {
      const pos = positive(item);
      const { predicted, correct } = predict(item, Tx);
      const hit = predicted && correct && pos;
      if (hit) tp++;
      else if (predicted) fp++;
      if (pos && !hit) fn++;
    }
    return { x, pr: pr(tp, fp, fn), current: Math.abs(x - T[name]) < 1e-9, best: false };
  });
  // Best F1; ties go to the row nearest the current value, so a flat plateau doesn't suggest a change.
  let best: SweepRow | undefined;
  for (const r of rows) {
    if (!best || r.pr.f1 > best.pr.f1 + 1e-9 || (Math.abs(r.pr.f1 - best.pr.f1) < 1e-9 && Math.abs(r.x - T[name]) < Math.abs(best.x - T[name]))) best = r;
  }
  if (best) best.best = true;
  return rows;
}

// ---------- the whole report ----------

export interface FamilyScore {
  n: number;
  errors: number;
  correct: number;
}

export interface IntentCaseRow {
  id: string;
  expect: string;
  got: string;
  ok: boolean;
}

export interface Scored {
  thresholds: Thresholds;
  intent: FamilyScore & {
    actionCorrect: number;
    deadlineN: number;
    deadlineCorrect: number;
    outcome: Confusion;
    kinds: Confusion;
    deadline: Confusion;
    wrong: IntentCaseRow[];
  };
  is_ask: FamilyScore & { confusion: Confusion; wrong: IntentCaseRow[] };
  reaction: FamilyScore & { confusion: Confusion; wrong: IntentCaseRow[] };
  sweeps: Partial<Record<keyof Thresholds, SweepRow[]>>;
  suggested: Partial<Thresholds>;
}

const byId = (records: RunRecord[]) => new Map(records.map((r) => [r.id, r]));

export function score(cases: Cases, records: RunRecord[], T: Thresholds): Scored {
  const recs = byId(records);
  const raws = <C extends { id: string }>(list: C[]) => list.flatMap((c) => (recs.get(c.id)?.raw ? [{ c, raw: recs.get(c.id)!.raw! }] : []));

  // intent
  const intent: Scored["intent"] = { n: 0, errors: 0, correct: 0, actionCorrect: 0, deadlineN: 0, deadlineCorrect: 0, outcome: {}, kinds: {}, deadline: {}, wrong: [] };
  for (const c of cases.intent) {
    intent.n++;
    const r = recs.get(c.id);
    if (!r?.raw) {
      intent.errors++;
      bump(intent.outcome, c.expect.outcome, "error");
      intent.wrong.push({ id: c.id, expect: `${c.expect.outcome} ${c.expect.action}`, got: `error: ${r?.error ?? "no record"}`, ok: false });
      continue;
    }
    const e = evalIntent(c, r.raw, T);
    const actionOk = e.choice === c.expect.action;
    const outcomeOk = e.outcome === c.expect.outcome && (c.expect.outcome === "none" || actionOk);
    bump(intent.outcome, c.expect.outcome, e.outcome);
    bump(intent.kinds, kindOf(c.expect.action), kindOf(e.choice));
    if (actionOk) intent.actionCorrect++;
    let deadlineOk = true;
    if ("deadline" in c.expect) {
      intent.deadlineN++;
      const want = c.expect.deadline ?? null;
      const bucket = want === null ? (e.deadline === null ? "null-correct" : "spurious") : e.deadline === null ? "missed" : e.deadline === want ? "date-correct" : "date-wrong";
      bump(intent.deadline, want === null ? "no date" : "date", bucket);
      deadlineOk = bucket === "null-correct" || bucket === "date-correct";
      if (deadlineOk) intent.deadlineCorrect++;
    }
    const ok = outcomeOk && deadlineOk;
    if (ok) intent.correct++;
    else intent.wrong.push({ id: c.id, expect: `${c.expect.outcome} ${c.expect.action}${"deadline" in c.expect ? ` @${c.expect.deadline}` : ""}`, got: `${e.outcome} ${e.choice} p=${e.p.toFixed(2)}${"deadline" in c.expect ? ` @${e.deadline}` : ""}`, ok });
  }

  // is_ask
  const isAsk: Scored["is_ask"] = { n: 0, errors: 0, correct: 0, confusion: {}, wrong: [] };
  for (const c of cases.is_ask) {
    isAsk.n++;
    const r = recs.get(c.id);
    if (!r?.raw) {
      isAsk.errors++;
      bump(isAsk.confusion, String(c.expect), "error");
      continue;
    }
    const p = isAskP(r.raw);
    const got = p >= T.IS_ASK_MIN;
    bump(isAsk.confusion, String(c.expect), String(got));
    if (got === c.expect) isAsk.correct++;
    else isAsk.wrong.push({ id: c.id, expect: String(c.expect), got: `${got} p=${p.toFixed(2)}`, ok: false });
  }

  // reaction
  const reaction: Scored["reaction"] = { n: 0, errors: 0, correct: 0, confusion: {}, wrong: [] };
  for (const c of cases.reaction) {
    reaction.n++;
    const r = recs.get(c.id);
    if (!r?.raw) {
      reaction.errors++;
      bump(reaction.confusion, c.expect, "error");
      continue;
    }
    const e = evalReaction(r.raw, T.REACTION_MIN);
    bump(reaction.confusion, c.expect, e.meaning);
    if (e.meaning === c.expect) reaction.correct++;
    else reaction.wrong.push({ id: c.id, expect: c.expect, got: `${e.meaning} (top ${e.top} p=${e.p.toFixed(2)})`, ok: false });
  }

  // sweeps
  const intentItems = raws(cases.intent);
  const sweeps: Scored["sweeps"] = {
    AUTO_P: sweep("AUTO_P", T, intentItems, (x) => x.c.expect.outcome === "auto", (x, Tx) => {
      const e = evalIntent(x.c, x.raw, Tx);
      return { predicted: e.outcome === "auto", correct: e.choice === x.c.expect.action };
    }),
    PROPOSE_P: sweep("PROPOSE_P", T, intentItems, (x) => x.c.expect.outcome !== "none", (x, Tx) => {
      const e = evalIntent(x.c, x.raw, Tx);
      return { predicted: e.outcome !== "none", correct: e.choice === x.c.expect.action };
    }),
    AMBIGUOUS_P: sweep("AMBIGUOUS_P", T, intentItems.filter((x) => "ambiguous" in x.c.expect), (x) => x.c.expect.ambiguous === true, (x, Tx) => {
      const e = evalIntent(x.c, x.raw, Tx);
      return { predicted: e.ambiguous >= Tx.AMBIGUOUS_P, correct: true };
    }),
    DELIVERS_P: sweep(
      "DELIVERS_P",
      T,
      intentItems.flatMap((x) => Object.keys(x.c.expect.delivers ?? {}).map((ref) => ({ ...x, ref }))),
      (x) => x.c.expect.delivers?.[x.ref] === true,
      (x, Tx) => ({ predicted: (evalIntent(x.c, x.raw, Tx).delivers[x.ref] ?? 0) >= Tx.DELIVERS_P, correct: true }),
    ),
    DEADLINE_P: sweep("DEADLINE_P", T, intentItems.filter((x) => "deadline" in x.c.expect), (x) => x.c.expect.deadline != null, (x, Tx) => {
      const e = evalIntent(x.c, x.raw, Tx);
      return { predicted: e.deadline !== null, correct: e.deadline === x.c.expect.deadline };
    }),
    IS_ASK_MIN: sweep("IS_ASK_MIN", T, raws(cases.is_ask), (x) => x.c.expect, (x, Tx) => ({ predicted: isAskP(x.raw) >= Tx.IS_ASK_MIN, correct: true })),
    REACTION_MIN: sweep("REACTION_MIN", T, raws(cases.reaction), (x) => x.c.expect !== "unclear", (x, Tx) => {
      const e = evalReaction(x.raw, Tx.REACTION_MIN);
      return { predicted: e.meaning !== "unclear", correct: e.meaning === x.c.expect };
    }),
  };
  const suggested: Partial<Thresholds> = {};
  for (const [name, rows] of Object.entries(sweeps) as [keyof Thresholds, SweepRow[]][]) {
    const best = rows.find((r) => r.best);
    if (best && !best.current) suggested[name] = best.x;
  }
  return { thresholds: T, intent, is_ask: isAsk, reaction, sweeps, suggested };
}

/** Outcome per case under its file's own thresholds, for `--compare`. */
export function outcomes(cases: Cases, file: ResultsFile): Map<string, string> {
  const T = file.meta.thresholds_used;
  const recs = byId(file.records);
  const out = new Map<string, string>();
  for (const c of cases.intent) {
    const r = recs.get(c.id);
    if (!r?.raw) out.set(c.id, "error");
    else {
      const e = evalIntent(c, r.raw, T);
      out.set(c.id, `${e.outcome} ${e.choice}${"deadline" in c.expect ? ` @${e.deadline}` : ""}`);
    }
  }
  for (const c of cases.is_ask) {
    const r = recs.get(c.id);
    out.set(c.id, r?.raw ? String(isAskP(r.raw) >= T.IS_ASK_MIN) : "error");
  }
  for (const c of cases.reaction) {
    const r = recs.get(c.id);
    out.set(c.id, r?.raw ? evalReaction(r.raw, T.REACTION_MIN).meaning : "error");
  }
  return out;
}

/** Scripted answers that a correct pipeline must turn into the label: the `--oracle` run. */
export function oracleAnswers(cases: Cases, id: string): { id: string; type: "choice" | "noul"; value: string | number; p: number }[] {
  const intent = cases.intent.find((c) => c.id === id);
  if (intent) {
    const { questions } = intentQuestions(intent);
    const e = intent.expect;
    const out: ReturnType<typeof oracleAnswers> = [{ id: "action", type: "choice", value: e.action, p: e.outcome === "auto" ? 0.95 : e.outcome === "propose" ? 0.7 : 0.95 }];
    if (questions.ambiguous) out.push({ id: "ambiguous", type: "noul", value: 0, p: e.ambiguous ? 0.9 : 0.05 });
    if (questions.deadline) out.push({ id: "deadline", type: "choice", value: e.deadline ?? "none", p: 0.9 });
    for (const [ref, v] of Object.entries(e.delivers ?? {})) out.push({ id: `delivers_${ref}`, type: "noul", value: 0, p: v ? 0.9 : 0.1 });
    return out;
  }
  const isAsk = cases.is_ask.find((c) => c.id === id);
  if (isAsk) return [{ id: "is_ask", type: "noul", value: 0, p: isAsk.expect ? 0.95 : 0.05 }];
  const reaction = cases.reaction.find((c) => c.id === id);
  if (reaction) return [{ id: "meaning", type: "choice", value: reaction.expect, p: 0.95 }];
  return [];
}
