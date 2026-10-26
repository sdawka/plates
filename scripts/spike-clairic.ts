// Clairic research spike: runs the date and thread experiments against Cloudflare Workers AI and writes
// docs/clairic-spike.md plus eval/results/clairic.<date>.json. No product code depends on this.
//
//   CF_ACCOUNT_ID=… CF_API_TOKEN=… npm run spike:clairic -- [--jev eval/results/typesafe__jev-1.14.systemone.json]
//                                                         [--only <id-prefix>] [--concurrency 2] [--dry-run]
//   npm run spike:clairic -- --export-jobs jobs.json          write the states to call by other means (no network)
//   npm run spike:clairic -- --import-results r.json [--jev …] render the report from {id: result} recorded elsewhere
//
// CF_API_TOKEN needs Workers AI run permission (wrangler's OAuth token works). Refuses to run under CI.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pMax } from "../src/decide.ts";
import { JEV_THRESHOLDS } from "../src/thresholds.ts";
import { clairic, ClairicError, type ClairicResult } from "./clairic/client.ts";
import { dateFields, dateState, threadFields, threadState, today } from "./clairic/state.ts";
import { dateRow, render, threadRow, type DateRow, type ThreadRow, type Totals } from "./clairic/report.ts";
import { FAMILIES, parseCases, type Family } from "./eval/cases.ts";
import type { ResultsFile } from "./eval/score.ts";

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) out[a.slice(2)] = next, i++;
    else out[a.slice(2)] = "";
  }
  return out;
}

/** Jev's deadline per case, exactly as production would keep it. */
function jevDeadlines(file: string): Map<string, string | null> {
  const results = JSON.parse(readFileSync(file, "utf8")) as ResultsFile;
  const out = new Map<string, string | null>();
  for (const r of results.records) {
    const a = r.raw?.deadline;
    if (!a || a.type !== "choice") continue;
    out.set(r.id, a.choice !== "none" && pMax(a) >= JEV_THRESHOLDS.DEADLINE_P ? a.choice : null);
  }
  return out;
}

async function main(): Promise<void> {
  const a = args();
  const files = Object.fromEntries(FAMILIES.map((f) => [f, readFileSync(`eval/cases/${f}.jsonl`, "utf8")])) as Record<Family, string>;
  const cases = parseCases(files);
  const pick = (id: string) => !("only" in a) || id.startsWith(a.only!);
  const dateCases = cases.intent.filter((c) => "deadline" in c.expect && pick(c.id));
  const threadCases = cases.extract.filter((c) => pick(c.id));
  const jobs: { kind: "date" | "thread"; id: string; state: string; fields: Record<string, unknown>; reference_date: string }[] = [
    ...dateCases.map((c) => ({ kind: "date" as const, id: c.id, state: dateState(c), fields: dateFields(today(c).date), reference_date: today(c).date })),
    ...threadCases.map((c) => ({ kind: "thread" as const, id: c.id, state: threadState(c), fields: threadFields(), reference_date: today(c).date })),
  ];

  if ("dry-run" in a) {
    console.log(`${dateCases.length} date cases, ${threadCases.length} thread cases`);
    for (const j of jobs.slice(0, 2)) console.log(`\n--- ${j.id}\n${j.state}\n${JSON.stringify(j.fields, null, 2)}`);
    return;
  }
  if ("export-jobs" in a) {
    writeFileSync(a["export-jobs"]!, `${JSON.stringify(jobs.map((j) => ({ id: j.id, kind: j.kind, reference_date: j.reference_date, state: j.state })))}\n`);
    console.error(`wrote ${jobs.length} jobs to ${a["export-jobs"]}`);
    return;
  }
  const jev = a.jev ? jevDeadlines(a.jev) : undefined;
  const results = new Map<string, ClairicResult | { error: string; ms: number }>();
  const totals: Totals = { calls: 0, errors: 0, ms: [], input_tokens: 0, output_tokens: 0, passes: 0, truncated: 0 };
  const record = (id: string, r: ClairicResult | { error: string; ms: number }) => {
    results.set(id, r);
    totals.calls++;
    if ("error" in r) {
      totals.errors++;
      console.error(`  ${id}: ${r.error}`);
      return;
    }
    totals.ms.push(r.ms);
    totals.input_tokens += r.usage.input_tokens ?? 0;
    totals.output_tokens += r.usage.output_tokens ?? 0;
    totals.passes += r.usage.passes ?? 1;
    if (r.truncated) totals.truncated++;
  };

  if ("import-results" in a) {
    const imported = JSON.parse(readFileSync(a["import-results"]!, "utf8")) as Record<string, ClairicResult | { error: string; ms: number }>;
    for (const j of jobs) record(j.id, imported[j.id] ?? { error: "no recorded result", ms: 0 });
  } else {
    if (process.env.CI) throw new Error("refusing to call a paid API under CI");
    const accountId = process.env.CF_ACCOUNT_ID, token = process.env.CF_API_TOKEN;
    if (!accountId || !token) throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN are required (or use --import-results)");
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++]!;
        const started = Date.now();
        try {
          record(j.id, await clairic({ accountId, token }, { state: j.state, fields: j.fields as never, reference_date: j.reference_date }));
        } catch (e) {
          record(j.id, { error: e instanceof ClairicError ? `${e.status} ${e.message}` : (e as Error).message, ms: Date.now() - started });
        }
        if (results.size % 10 === 0 || results.size === jobs.length) console.error(`  ${results.size}/${jobs.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(a.concurrency ?? 2)) }, worker));
  }

  const dates: DateRow[] = dateCases.map((c) => dateRow(c.id, c.text, c.expect.deadline ?? null, jev ? jev.get(c.id) : undefined, results.get(c.id)!));
  const threads: ThreadRow[] = threadCases.map((c) => {
    const dues = c.expect.asks.map((x) => x.due).filter((x): x is string => !!x).sort();
    return threadRow(c.id, c.expect.asks.length, dues[0] ?? null, results.get(c.id)!);
  });
  const ranAt = new Date().toISOString();
  const gitSha = (() => { try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
  const report = render({ ranAt, gitSha, jevFile: a.jev, source: "import-results" in a ? `imported from ${a["import-results"]!.split("/").pop()} (recorded through the Cloudflare API with the same states and fields)` : "fetched by the script's REST client", dates, threads, totals, dateFields: dateFields(jobs[0]?.reference_date ?? "2026-10-19"), threadFields: threadFields(), sampleState: jobs[0]?.state ?? "" });
  const outJson = `eval/results/clairic.${ranAt.slice(0, 10)}.json`;
  writeFileSync(outJson, `${JSON.stringify({ meta: { model: "@cf/cloudflare/clairic", ran_at: ranAt, git_sha: gitSha, jev: a.jev ?? null }, jobs: jobs.map((j) => ({ ...j, result: results.get(j.id) })) }, null, 1)}\n`);
  writeFileSync("docs/clairic-spike.md", report);
  console.error(`wrote docs/clairic-spike.md and ${outJson}`);
  console.log(report.split("## Productise?")[1]?.split("Open questions")[0] ?? "");
}

main().catch((e: unknown) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
