// Renders a Scored result as Markdown for the terminal (and for pasting into a PR).
import type { Thresholds } from "../../src/thresholds.ts";
import type { Confusion, Scored, SweepRow } from "./score.ts";

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const f = (x: number) => x.toFixed(2);

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  return [line(header), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...rows.map(line)].join("\n");
}

function confusion(title: string, m: Confusion): string {
  const labels = Object.keys(m).sort();
  const preds = [...new Set(labels.flatMap((l) => Object.keys(m[l]!)))].sort();
  return `${title} (rows: label, columns: predicted)\n${table(["", ...preds], labels.map((l) => [l, ...preds.map((p) => String(m[l]![p] ?? 0))]))}`;
}

function sweepTable(name: string, rows: SweepRow[]): string {
  const body = rows.map((r) => [
    `${r.current ? "*" : " "}${r.best ? "!" : " "} ${f(r.x)}`,
    String(r.pr.tp), String(r.pr.fp), String(r.pr.fn), f(r.pr.precision), f(r.pr.recall), f(r.pr.f1),
  ]);
  return `${name} (* current, ! best F1)\n${table(["x", "tp", "fp", "fn", "precision", "recall", "f1"], body)}`;
}

export function render(s: Scored, title: string): string {
  const parts: string[] = [`# Eval: ${title}`, ""];
  parts.push("## Accuracy at the current thresholds", "");
  parts.push(
    table(
      ["family", "cases", "errors", "correct", "accuracy", "notes"],
      [
        ["intent", String(s.intent.n), String(s.intent.errors), String(s.intent.correct), pct(s.intent.correct, s.intent.n), `action ${pct(s.intent.actionCorrect, s.intent.n)}, deadline ${pct(s.intent.deadlineCorrect, s.intent.deadlineN)} of ${s.intent.deadlineN}`],
        ["is_ask", String(s.is_ask.n), String(s.is_ask.errors), String(s.is_ask.correct), pct(s.is_ask.correct, s.is_ask.n), ""],
        ["reaction", String(s.reaction.n), String(s.reaction.errors), String(s.reaction.correct), pct(s.reaction.correct, s.reaction.n), ""],
      ],
    ),
    "",
  );
  parts.push(`Thresholds: ${JSON.stringify(s.thresholds)}`, "");
  parts.push("## Confusions", "");
  parts.push(confusion("Intent outcome", s.intent.outcome), "");
  parts.push(confusion("Intent action kind", s.intent.kinds), "");
  if (s.intent.deadlineN) parts.push(confusion("Intent deadline", s.intent.deadline), "");
  parts.push(confusion("is_ask", s.is_ask.confusion), "");
  parts.push(confusion("Reaction", s.reaction.confusion), "");
  const wrong = [...s.intent.wrong, ...s.is_ask.wrong, ...s.reaction.wrong];
  if (wrong.length) parts.push("## Misses", "", table(["case", "expected", "got"], wrong.map((w) => [w.id, w.expect, w.got])), "");
  parts.push("## Threshold sweeps", "");
  for (const [name, rows] of Object.entries(s.sweeps)) if (rows) parts.push(sweepTable(name, rows), "");
  parts.push("## Suggested overrides (best F1, one threshold at a time; adopt only after reading the sweeps)", "");
  parts.push("```ts", `// src/thresholds.ts BY_MODEL entry`, JSON.stringify(s.suggested as Partial<Thresholds>, null, 2), "```", "");
  return parts.join("\n");
}
