// Decision-model eval: runs eval/cases/*.jsonl against a model through the production client and question
// builders, records raw probabilities, and reports accuracy, confusions and threshold sweeps.
//
//   npm run eval -- --model typesafe/jev-1.14 [--api systemone|decisions] [--family intent,is_ask,reaction]
//                   [--only <id-prefix>] [--concurrency 4] [--out eval/results/x.json]
//   npm run eval -- --dry-run                       validate labels, print counts and sizes, no network
//   npm run eval -- --oracle                        scripted answers equal to the labels: must score 100%
//   npm run eval -- --rescore eval/results/x.json   re-score a results file (optionally at --model's thresholds)
//   npm run eval -- --compare a.json --compare b.json   cases whose outcome differs between two runs
//
// Needs OPENROUTER_API_KEY in the environment for a real run (e.g. `set -a; source .secrets.env`).
// Refuses to run under CI: it costs money. Results are committed so model runs can be diffed.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SYSTEMONE_KEY, FakeSystemOne } from "../test/helpers/fakeSystemOne.ts";
import { Network } from "../test/helpers/net.ts";
import { thresholdsFor } from "../src/thresholds.ts";
import type { Env } from "../src/types.ts";
import { DECIDE_FAMILIES, FAMILIES, intentQuestions, isAskQuestions, parseCases, reactionQuestions, type Cases, type Family } from "./eval/cases.ts";
import { render } from "./eval/report.ts";
import { runCases } from "./eval/run.ts";
import { oracleAnswers, outcomes, score, type ResultsFile } from "./eval/score.ts";

const CASES_DIR = "eval/cases";
const RESULTS_DIR = "eval/results";

function args(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      (out[key] ??= []).push(next);
      i++;
    } else (out[key] ??= []).push("");
  }
  return out;
}

function loadCases(): { cases: Cases; sha: Record<string, string> } {
  const files = Object.fromEntries(FAMILIES.map((f) => [f, readFileSync(`${CASES_DIR}/${f}.jsonl`, "utf8")])) as Record<Family, string>;
  const sha = Object.fromEntries(FAMILIES.map((f) => [f, createHash("sha256").update(files[f]).digest("hex").slice(0, 12)]));
  return { cases: parseCases(files), sha };
}

const readResults = (file: string): ResultsFile => JSON.parse(readFileSync(file, "utf8")) as ResultsFile;
const resultsPath = (model: string, api: string) => `${RESULTS_DIR}/${model.replace(/\//g, "__")}.${api}.json`;

async function main(): Promise<void> {
  const a = args();
  const flag = (k: string) => k in a;
  const str = (k: string) => a[k]?.[0] || undefined;
  const { cases, sha } = loadCases();
  const counts = Object.fromEntries(FAMILIES.map((f) => [f, cases[f].length]));

  if (flag("compare")) {
    const [x, y] = a.compare!;
    if (!x || !y) throw new Error("--compare takes two results files");
    const fx = readResults(x), fy = readResults(y);
    const ox = outcomes(cases, fx), oy = outcomes(cases, fy);
    const flips = [...ox.keys()].filter((id) => ox.get(id) !== oy.get(id));
    console.log(`# Compare\n\nA: ${x} (${fx.meta.model}, ${fx.meta.api})\nB: ${y} (${fy.meta.model}, ${fy.meta.api})\n\n${flips.length} of ${ox.size} cases differ.\n`);
    for (const id of flips) console.log(`- ${id}: A ${ox.get(id)}  |  B ${oy.get(id)}`);
    return;
  }

  if (flag("rescore")) {
    const file = readResults(str("rescore")!);
    const model = str("model") ?? file.meta.model;
    const s = score(cases, file.records, thresholdsFor(model));
    console.log(render(s, `${str("rescore")} rescored at ${model}'s thresholds`));
    return;
  }

  if (flag("dry-run")) {
    console.log(`cases: ${JSON.stringify(counts)} (all labels valid)`);
    const size = (q: { state: unknown; questions: unknown }) => JSON.stringify(q).length;
    const sizes = [
      ...cases.intent.map((c) => size(intentQuestions(c))),
      ...cases.is_ask.map((c) => size(isAskQuestions(c))),
      ...cases.reaction.map((c) => size(reactionQuestions(c))),
    ].sort((x, y) => x - y);
    console.log(`request sizes (chars): min ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes[sizes.length - 1]}`);
    return;
  }

  const oracle = flag("oracle");
  const model = str("model") ?? (oracle ? "typesafe/jev-1.14" : undefined);
  if (!model) throw new Error("--model <vendor/model> is required (or --dry-run / --oracle / --rescore / --compare)");
  const api = (str("api") ?? "systemone") as Env["DECIDE_API"];
  if (api !== "systemone" && api !== "decisions") throw new Error(`--api must be systemone or decisions, got ${api}`);
  const families = (str("family")?.split(",") as Family[] | undefined) ?? [...DECIDE_FAMILIES];
  for (const f of families) if (!DECIDE_FAMILIES.includes(f)) throw new Error(`--family: ${f} is not one of ${DECIDE_FAMILIES.join(", ")}`);

  let baseUrl = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api";
  let apiKey = process.env.OPENROUTER_API_KEY;
  let fake: FakeSystemOne | undefined;
  if (oracle) {
    baseUrl = "https://oracle.test";
    apiKey = SYSTEMONE_KEY;
    const net = new Network();
    fake = new FakeSystemOne();
    fake.attach(net, baseUrl);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => net.fetch(new Request(input as RequestInfo, init))) as typeof fetch;
  } else {
    if (process.env.CI) throw new Error("refusing to run a paid eval under CI");
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (try: set -a; source .secrets.env)");
  }
  const env = { OPENROUTER_API_KEY: apiKey, DECIDE_MODEL: model, DECIDE_API: api, LLM_BASE_URL: baseUrl } as Env;

  const started = Date.now();
  const records = await runCases(cases, {
    env,
    families,
    only: str("only"),
    concurrency: oracle ? 1 : Number(str("concurrency") ?? 4),
    before: fake
      ? (_family, id) => {
          for (const q of oracleAnswers(cases, id)) q.type === "choice" ? fake!.queueChoice(q.id, String(q.value), q.p) : fake!.queueNoul(q.id, q.p);
        }
      : undefined,
    onProgress: (done, total, rec) => {
      if (rec.error) console.error(`  ${rec.id}: ${rec.error}`);
      if (done % 25 === 0 || done === total) console.error(`  ${done}/${total}`);
    },
  });
  const errors = records.filter((r) => r.error).length;
  console.error(`ran ${records.length} cases in ${((Date.now() - started) / 1000).toFixed(1)}s, ${errors} errors`);

  const thresholds = thresholdsFor(model);
  const file: ResultsFile = {
    meta: { model, api: api!, git_sha: gitSha(), ran_at: new Date().toISOString(), cases_sha256: sha, thresholds_used: thresholds },
    records,
  };
  if (!oracle) {
    const out = str("out") ?? resultsPath(model, api!);
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(out, `${JSON.stringify(file, null, 1)}\n`);
    console.error(`wrote ${out}`);
  }
  const s = score(cases, records, thresholds);
  console.log(render(s, `${model} via ${api}${oracle ? " (oracle)" : ""}`));
  if (oracle) {
    const perfect = s.intent.correct === s.intent.n && s.is_ask.correct === s.is_ask.n && s.reaction.correct === s.reaction.n;
    if (!perfect) {
      console.error("ORACLE FAILED: scripted labels did not round-trip to 100%");
      process.exit(1);
    }
    console.error("oracle: 100% on every family");
  }
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
