# Development

```sh
npm install
npm run typecheck    # tsc over src, test and logs/src
npm test             # vitest: unit tests and end-to-end tests against fakes, no network
npm run local:e2e    # the real Worker in workerd against mock servers
npm run dev          # wrangler dev with .dev.vars (copy .dev.vars.example)
```

None of the checks need credentials. Node 24 or newer.

## Tests

`test/` holds unit tests for the pure modules (state machine, renderers, parsers, schedule math, validation) and end-to-end tests under `test/e2e/` that drive the Worker the way Slack does.

The harness in `test/helpers/env.ts` builds a complete `Env`: an in-memory D1 with every migration applied (`fakeD1.ts`), a fake queue that runs the consumer, a real `PlateKeeper` on shim storage, a controllable clock, and fakes for Slack's Web API (`fakeSlack.ts`, stateful: channels, threads, DMs, Home views), Anthropic's Messages API (`fakeAnthropic.ts`, which also checks strict tool schemas), System One (`fakeSystemOne.ts`, scripted answers per question id) and Jira and Linear (`fakeTrackers.ts`). `slackIngress.ts` signs requests like Slack and `scenario.ts` plays common sequences (tag a thread, confirm, act). The fakes are shaped from the official docs, and `test/e2e/docs.test.ts` pins the behaviours taken from them.

`test/domain.graph.test.ts` fails when `docs/state-machine.md` is stale; run `npm run diagram` after changing `RULES`.

## Local end-to-end run

`npm run local:e2e` starts `wrangler dev --local` (real D1, Queues and Durable Object alarms in workerd) and one Node server that mocks Slack, the Anthropic Messages endpoint and System One (`scripts/mock-servers.ts`), then plays scenarios against the Worker and asserts on what the mocks recorded and on D1. `ONLY=c,e npm run local:e2e` runs the scenarios whose names start with those letters. `npm run local:mock` starts only the mock servers for poking at `wrangler dev` by hand; `.dev.vars.example` shows the two variables that point the Worker at them.

## Scripts

Scripts under `scripts/` are TypeScript run through `node scripts/run.mjs <file>`, which bundles them with esbuild. They are outside `tsconfig.json`, except that `scripts/eval/cases.ts` and `scripts/eval/score.ts` are imported by tests and must typecheck and stay free of Node imports.

| Script | Purpose |
|---|---|
| `npm run diagram` | Regenerates `docs/state-machine.md` from `RULES` |
| `npm run eval` | Decision-model eval, below |
| `npm run screenshots` | Plays a scenario through the test harness and renders the real Block Kit as Slack-styled PNGs in `docs/images/` for the README. Needs Google Chrome and Python with Pillow |
| `npm run spike:clairic` | Research spike for Cloudflare's Clairic model; writes `docs/clairic-spike.md`. Needs `CF_ACCOUNT_ID` and `CF_API_TOKEN` (Workers AI run permission). Nothing under `src/` may import `scripts/clairic/` |

## The decision-model eval

The thread-reply intent, the DM filter and emoji meaning are answered by a decision model with probabilities, and the probabilities are gated on thresholds. Probabilities are not comparable across models, so each model gets its own entry in `src/thresholds.ts`, tuned from a labelled eval.

```sh
set -a; source .secrets.env; set +a            # or export OPENROUTER_API_KEY
npm run eval -- --dry-run                      # validate labels, print counts and request sizes, no network
npm run eval -- --oracle                       # scripted answers equal to the labels must score 100%
npm run eval -- --model typesafe/jev-1.14      # a real run; writes eval/results/typesafe__jev-1.14.systemone.json
npm run eval -- --model cloudflare/clef-flash --api decisions
npm run eval -- --rescore eval/results/typesafe__jev-1.14.systemone.json
npm run eval -- --compare eval/results/a.json --compare eval/results/b.json
```

Cases live in `eval/cases/*.jsonl`, one JSON object per line, hand-editable: `intent` (a reply, the open asks and the expected action, outcome and date), `is_ask`, `reaction` and `extract` (threads, used by the Clairic spike). The loader rejects a label the state machine would not offer, so labels cannot drift from the code. Every case has a fixed clock so date options are stable.

The runner calls the production client and the production question builders, records raw probabilities before any threshold, and scores with the production reducer and validator, so the report judges exactly what Plates would do. It prints accuracy per family, confusion matrices, the misses, a precision/recall sweep for each threshold with the current and best-F1 rows marked, and a paste-ready `BY_MODEL` block. Results are committed so runs can be diffed.

The eval costs money and refuses to run when `CI` is set. Adopt suggested thresholds only after reading the sweeps; the committed results show the baseline each entry came from.

## Adding things

- **A new decision model**: set `DECIDE_MODEL` (and `DECIDE_API` if it is only on the decisions route), run the eval, add a `BY_MODEL` entry with the file it came from.
- **A new ask action**: add it to `RULES` in `src/domain/transitions.ts` and `AskAction` in `src/types.ts`; the intent options, the diagram and the button layout follow. Add the Block Kit button or modal in `src/slack/`.
- **A new tracker**: implement `src/trackers/types.ts`, register it in `src/trackers/index.ts`, add a fake in `test/helpers/fakeTrackers.ts` and cases in `test/trackers.sync.test.ts`.
- **A new effect**: add the variant to `Effect` in `src/types.ts` and a handler in `src/effects.ts`.

## Conventions

- Files start with a comment saying what the module is for and whether it is pure.
- Nothing account-specific in tracked files. `.dev.vars` and `.secrets.env` are ignored; the manifest uses `WORKER_URL` placeholders; `wrangler.jsonc` names resources without ids.
- No promotional lines in commits or code.
