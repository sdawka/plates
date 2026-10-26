// Scores the Clairic spike and renders docs/clairic-spike.md. Pure.
import type { ClairicAnswer, ClairicResult } from "./client.ts";

export interface DateRow {
  id: string;
  text: string;
  expect: string | null;
  jev: string | null | undefined; // undefined when no Jev record
  clairic: string | null;
  p_null: number | null;
  estimate: string | null;
  due_at: string | null;
  confidence: number | null;
  ms: number;
  error?: string;
}

export interface ThreadRow {
  id: string;
  expectCount: number;
  expectFirstDue: string | null;
  count: number | null;
  asks: string[];
  firstDue: string | null;
  ms: number;
  error?: string;
}

export interface Totals {
  calls: number;
  errors: number;
  ms: number[];
  input_tokens: number;
  output_tokens: number;
  passes: number;
  truncated: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
export const asDate = (v: unknown): string | null => (typeof v === "string" && DATE_RE.test(v) ? v.slice(0, 10) : null);
export const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export type Bucket = "exact" | "off-by-one" | "wrong" | "missed" | "null-correct" | "spurious" | "error";

export function bucket(expect: string | null, got: string | null | undefined, error?: string): Bucket {
  if (error || got === undefined) return "error";
  if (expect === null) return got === null ? "null-correct" : "spurious";
  if (got === null) return "missed";
  const d = Math.abs(dayDiff(got, expect));
  return d === 0 ? "exact" : d === 1 ? "off-by-one" : "wrong";
}

export function tally<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

/** Sweep null_threshold: value is null when p_null > t. Precision/recall of "no deadline". */
export function nullSweep(rows: DateRow[]): { t: number; tp: number; fp: number; fn: number; precision: number; recall: number }[] {
  const usable = rows.filter((r) => r.p_null !== null);
  return Array.from({ length: 19 }, (_, i) => (i + 1) / 20).map((t) => {
    let tp = 0, fp = 0, fn = 0;
    for (const r of usable) {
      const predNull = r.p_null! > t;
      const isNull = r.expect === null;
      if (predNull && isNull) tp++;
      else if (predNull) fp++;
      else if (isNull) fn++;
    }
    return { t, tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 };
  });
}

export function dateRow(id: string, text: string, expect: string | null, jev: string | null | undefined, r: ClairicResult | { error: string; ms: number }): DateRow {
  if ("error" in r) return { id, text, expect, jev, clairic: null, p_null: null, estimate: null, due_at: null, confidence: null, ms: r.ms, error: r.error };
  const a = (k: string): ClairicAnswer | undefined => r.answers[k];
  const est = a("due_estimate");
  return {
    id, text, expect, jev,
    clairic: asDate(a("due_date")?.value),
    p_null: typeof a("due_date")?.p_null === "number" ? a("due_date")!.p_null! : null,
    estimate: asDate(est?.value) ?? asDate(est?.median) ?? asDate(est?.mean),
    due_at: typeof a("due_at")?.value === "string" ? (a("due_at")!.value as string) : null,
    confidence: typeof a("due_date")?.confidence === "number" ? a("due_date")!.confidence! : null,
    ms: r.ms,
  };
}

export function threadRow(id: string, expectCount: number, expectFirstDue: string | null, r: ClairicResult | { error: string; ms: number }): ThreadRow {
  if ("error" in r) return { id, expectCount, expectFirstDue, count: null, asks: [], firstDue: null, ms: r.ms, error: r.error };
  const count = r.answers.ask_count?.value;
  const asks = r.answers.asks?.value;
  return {
    id, expectCount, expectFirstDue,
    count: typeof count === "number" ? count : null,
    asks: Array.isArray(asks) ? asks.map(String) : [],
    firstDue: asDate(r.answers.first_due?.value),
    ms: r.ms,
  };
}

function table(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (c: unknown) => (c === null || c === undefined ? "—" : String(c)).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "n/a");

export interface ReportInput {
  ranAt: string;
  gitSha: string;
  jevFile?: string;
  /** How the answers were obtained, e.g. "the script's REST client" or "imported from …". */
  source: string;
  dates: DateRow[];
  threads: ThreadRow[];
  totals: Totals;
  dateFields: unknown;
  threadFields: unknown;
  sampleState: string;
}

export function render(i: ReportInput): string {
  const d = i.dates.filter((r) => !r.error);
  const cl = tally(i.dates.map((r) => bucket(r.expect, r.clairic, r.error)));
  const jv = tally(i.dates.map((r) => bucket(r.expect, r.jev)));
  const withDate = d.filter((r) => r.expect !== null);
  const noDate = d.filter((r) => r.expect === null);
  const okC = (cl.exact ?? 0) + (cl["null-correct"] ?? 0);
  const okJ = (jv.exact ?? 0) + (jv["null-correct"] ?? 0);
  const estErr = withDate.filter((r) => r.estimate).map((r) => Math.abs(dayDiff(r.estimate!, r.expect!)));
  const sweep = nullSweep(i.dates);
  const good = sweep.filter((s) => s.precision >= 0.9 && s.tp > 0).sort((a, b) => b.recall - a.recall || Math.abs(a.t - 0.5) - Math.abs(b.t - 0.5))[0];
  const t = i.threads.filter((r) => !r.error);
  const countExact = t.filter((r) => r.count === r.expectCount).length;
  const countNear = t.filter((r) => r.count !== null && Math.abs(r.count - r.expectCount) <= 1).length;
  const dueOk = t.filter((r) => bucket(r.expectFirstDue, r.firstDue) === "exact" || bucket(r.expectFirstDue, r.firstDue) === "null-correct").length;
  const ms = i.totals.ms;
  const p50 = percentile(ms, 50), p95 = percentile(ms, 95);
  const tokPerCall = i.totals.calls ? Math.round(i.totals.input_tokens / i.totals.calls) : 0;
  const criteria: [string, boolean | null, string][] = [
    ["Date accuracy (exact or null-correct) ≥ Jev on the same cases", okC >= okJ, `Clairic ${okC}/${i.dates.length} vs Jev ${okJ}/${i.dates.length}`],
    ["A null_threshold with precision ≥ 0.9 on no-deadline cases", !!good, good ? `t=${good.t.toFixed(2)} precision ${good.precision.toFixed(2)} recall ${good.recall.toFixed(2)}` : "none found"],
    ["p95 latency under 3 s (Jev-equivalent call budget)", p95 ? p95 < 3000 : null, `p50 ${p50} ms, p95 ${p95} ms`],
    ["Input tokens per call under 1,000", i.totals.calls ? tokPerCall < 1000 : null, `${tokPerCall} input tokens per call, ${(i.totals.passes / Math.max(1, i.totals.calls)).toFixed(1)} passes per call`],
    ["Zero permanent errors", i.totals.errors === 0, `${i.totals.errors} errors in ${i.totals.calls} calls`],
  ];
  const parts = [
    "# Clairic spike: can Cloudflare's extraction model replace the 21-day date list?",
    "",
    `Run ${i.ranAt} at commit ${i.gitSha} by \`npm run spike:clairic\`; answers ${i.source}. Research only: nothing in \`src/\` uses Clairic.`,
    "",
    "## Method",
    "",
    "Clairic (`@cf/cloudflare/clairic`, Workers AI preview) is called over REST with a short state string and typed fields. Two experiments:",
    "",
    `- **Dates**: every intent case in \`eval/cases/intent.jsonl\` that carries a deadline label (${i.dates.length} cases, ${withDate.length} with a date, ${noDate.length} without). The state names today, the open asks and the reply; the fields are \`due_date\` (date), \`due_at\` (datetime, "EOD means 17:00") and \`due_estimate\` (estimate over today … today+21 days, the analogue of Jev's choice list). \`reference_date\` is today.`,
    `- **Threads**: \`eval/cases/extract.jsonl\` (${i.threads.length} threads). Fields: \`ask_count\` (integer), \`asks\` (list of text), \`first_due\` (date).`,
    i.jevFile ? `- **Jev side by side**: the deadline Jev named for the same case, from \`${i.jevFile}\` (its \`deadline\` choice, kept when p ≥ 0.5). Jev only sees a 21-day list, so a date beyond it is labelled null for both.` : "- No Jev results file was given, so the side-by-side column is empty.",
    "",
    "Sample state:",
    "",
    "```",
    i.sampleState,
    "```",
    "",
    "## Dates",
    "",
    table(["bucket", "Clairic", "Jev"], ["exact", "off-by-one", "wrong", "missed", "null-correct", "spurious", "error"].map((b) => [b, cl[b] ?? 0, jv[b] ?? 0])),
    "",
    `Correct (exact or null-correct): Clairic ${pct(okC, i.dates.length)}, Jev ${pct(okJ, i.dates.length)}.`,
    "",
    `\`due_estimate\` absolute error in days on cases with a date (${estErr.length} parsed): mean ${estErr.length ? (estErr.reduce((a, b) => a + b, 0) / estErr.length).toFixed(1) : "n/a"}, p90 ${percentile(estErr, 90)}.`,
    "",
    "### p_null calibration (`due_date`)",
    "",
    "Value is null when p_null > t. Positive class: the reply names no day.",
    "",
    table(["t", "tp", "fp", "fn", "precision", "recall"], sweep.map((s) => [s.t.toFixed(2), s.tp, s.fp, s.fn, s.precision.toFixed(2), s.recall.toFixed(2)])),
    "",
    "### Per case",
    "",
    table(["case", "reply", "expected", "Jev", "Clairic", "p_null", "estimate", "due_at", "ms"], i.dates.map((r) => [r.id, r.text, r.expect, r.jev === undefined ? "—" : r.jev, r.error ? `error: ${r.error}` : r.clairic, r.p_null?.toFixed(2), r.estimate, r.due_at, r.ms])),
    "",
    "## Threads",
    "",
    `ask_count exact ${pct(countExact, i.threads.length)}, within ±1 ${pct(countNear, i.threads.length)}; first_due correct ${pct(dueOk, i.threads.length)}.`,
    "",
    table(["case", "expected", "count", "first_due (expected)", "asks", "ms"], i.threads.map((r) => [r.id, r.expectCount, r.error ? `error: ${r.error}` : r.count, `${r.firstDue ?? "—"} (${r.expectFirstDue ?? "—"})`, r.asks.join("; "), r.ms])),
    "",
    "## Cost and latency",
    "",
    table(["calls", "errors", "p50 ms", "p95 ms", "input tokens", "output tokens", "passes", "truncated"], [[i.totals.calls, i.totals.errors, p50, p95, i.totals.input_tokens, i.totals.output_tokens, i.totals.passes, i.totals.truncated]]),
    "",
    "## Productise?",
    "",
    table(["criterion", "met", "evidence"], criteria.map(([c, met, ev]) => [c, met === null ? "n/a" : met ? "yes" : "no", ev])),
    "",
    "Open questions before any product code:",
    "",
    "- Binding vs REST: a Worker would use the `ai` binding (no token, same account); the REST path here is for the spike only.",
    "- Preview stability: the model is marked preview; field semantics (especially `estimate` for dates and `p_null`) may change.",
    "- Time zones: `due_at` has no zone; Plates would still need `parseDue` to anchor 23:59 local.",
    "- Scope: Clairic answers \"which day\" well or badly, but not \"accept, reject or done\"; it would sit next to the decision model, not replace it.",
    "- `value` and `p_null` can disagree (a value returned with p_null near 1): a caller must apply its own null threshold to `p_null` rather than trust `value`.",
    "- Weekday arithmetic: check the per-case table for bare weekday names; an off-by-one there is a model error, not a label error.",
    "",
    "## Fields used",
    "",
    "```json",
    JSON.stringify({ dates: i.dateFields, threads: i.threadFields }, null, 2),
    "```",
    "",
  ];
  return parts.join("\n");
}
