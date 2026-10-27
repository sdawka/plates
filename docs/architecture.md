# Architecture

Plates is one Cloudflare Worker that receives Slack's HTTP calls, a queue that does the slow model work, a D1 database, and one Durable Object per person for timers. Claude and a System One decision model are called through OpenRouter. A second, optional Worker stores logs.

```
Slack ──events / interactions / slash commands──▶ Worker  src/index.ts
                                                   │  verify signature, answer within 3 s
                                                   ├─▶ Queue plates-extract ─▶ src/extract   thread → asks (Claude)
                                                   │                           src/intent    reply → action (decision model)
                                                   ├─▶ D1 plates              requests, asks, events, prefs, proposals, tokens
                                                   ├─▶ Durable Object PlateKeeper (one per user)
                                                   │     alarms: snooze wake-ups, reminders, daily digest, unconfirmed nudges
                                                   └─▶ Effects: thread message, DMs, Home tab, tracker sync
                                                              │
                                        Tail Worker plates-logs (logs/)  ◀─ every invocation's log lines
```

## Request lifecycle

1. **Ingress** (`src/index.ts`, `src/slack/`). Every POST is HMAC-verified with the signing secret. Slack retries are acknowledged and dropped (the first delivery is already running). Event callbacks return `ok` at once and do the work in `ctx.waitUntil`; interactions (buttons, menus, modals) and the `/plates` command do the same, except modal submissions, which run inline so validation errors can appear in the modal.
2. **Capture** (`src/slack/events.ts` → queue). An `@plates` mention, a `/plates` command, the message shortcut or a DM to the bot becomes an `ExtractJob`. The handler posts the "👀 Reading the thread…" placeholder and enqueues; nothing slow happens in the HTTP handler.
3. **Extraction** (`src/extract/`, in the queue consumer). The job gathers the thread with stable message ids (`context.ts`), asks Claude for structured output through a strict tool schema (`prompt.ts`, `llm.ts`), and validates everything the model returned (`validate.ts`): every ask must cite a real message, people must be real participants, enums are clamped. DMs first go through an `is_ask` question to the decision model so chatter is not extracted. The result is a request in `pending_confirmation` with draft asks, rendered into the placeholder as the confirmation card.
4. **Confirmation**. The requester or owner confirms with the button or ✅; ❌ asks what is off; any other emoji goes to the decision model (`meaning`: yes / no / unclear) and, when unclear, to a short clarifying question from the fast model. Confirming creates the asks and DMs the owner. Anyone can correct the draft by replying in the thread before it is confirmed; the same card updates.
5. **Moves** (`src/domain/`). Buttons, Home, thread replies, reactions, DMs and the keeper all call `service.ts`, the only module that changes asks. It applies `transition()` from `transitions.ts`, a pure state machine built from `RULES` (who may do what from which state, where the ask lands, which DM the move triggers), writes the ask and its event, and returns a list of `Effect`s.
6. **Effects** (`src/effects.ts`). Each effect runs independently and a failure never stops the others: re-render the thread message, send a DM, refresh a Home tab, reschedule a keeper, reply in a thread, settle a DM's buttons, sync a tracker. The queue consumer retries a job whose request message could not be posted.
7. **Thread replies** (`src/intent/`). Every message in a thread that has a request is read, tag or no tag. `questions.ts` builds a multiple-choice question whose options are exactly the `<ask>:<action>` pairs the state machine allows this speaker, plus `none`; the decision model answers with probabilities; `validate.ts` decides between applying the action with an Undo line, proposing it as "Did you mean", or ignoring it, using the per-model thresholds in `src/thresholds.ts`. Notes and redirect targets are taken from the message in code, never generated. The same path spots an owner sharing a link or file without saying "done" and proposes it.
8. **Timers** (`src/keeper/`). `PlateKeeper` is a Durable Object keyed by user id. It owns that user's alarm: snooze wake-ups, the reminder ladder after a deadline (deadline day, next working day, then weekly, capped per day), the daily digest at their work start, and the next-working-day nudge for unconfirmed requests. All work is idempotent, so a repeated alarm is harmless. Pure helpers (`schedule.ts`, `reminders.ts`, `time.ts`, `digest.ts`) compute what is due and when the next alarm fires.
9. **Home tab** (`src/home/`). Republished on every change for the people involved: needs your response, on your plate, unconfirmed, waiting on others, with the same actions as the thread and DMs.

## Module map

| Path | Role |
|---|---|
| `src/types.ts` | Shared contracts: `Env`, rows, actions, effects, queue jobs. Everything depends on it. |
| `src/domain/` | `transitions.ts` pure state machine · `service.ts` the only writers · `repo.ts` D1 access · `diagram.ts` renders the state machine as docs |
| `src/extract/` | Thread → asks: context gathering, prompt and strict tool schema, Claude call, validation, the DM filter and emoji questions |
| `src/intent/` | Thread reply → action: question builder, validation at thresholds, Undo and "Did you mean" handlers, proposals table |
| `src/slack/` | Signature check, event and interaction routing, slash command, Block Kit renderers, modals, settings, help text, Web API client |
| `src/home/` | Home tab queries and the pure view renderer |
| `src/keeper/` | `PlateKeeper` Durable Object and the pure scheduling, reminder and timezone math |
| `src/effects.ts` | Executes effects returned by the domain and extraction modules |
| `src/oauth/` | Opt-in user-token OAuth so extraction can read DMs the bot is not in; tokens encrypted with `TOKEN_ENC_KEY` |
| `src/trackers/` | Jira Cloud and Linear mirroring of deliverable asks, idempotent through `tracker_sync` |
| `src/llm.ts`, `src/decide.ts` | The Claude tool-call client and the decision-model client (OpenRouter) |
| `src/thresholds.ts` | Probability thresholds per decision model |
| `src/log.ts` | One JSON line per notable step; ids and kinds only |
| `migrations/` | D1 schema, applied in order by `wrangler d1 migrations apply` |
| `logs/` | The Tail Worker: ingest, Access check, server-rendered pages, its own schema |
| `scripts/` | Local end-to-end run and mock servers, the eval runner, the state-machine diagram, the Clairic research spike |
| `test/` | Vitest unit tests and end-to-end tests against docs-shaped fakes of Slack, Anthropic, System One, Jira and Linear |
| `eval/` | Labelled cases for the decision model and committed results per model |

## Design rules

- **Pure core, thin edges.** Renderers, parsers, the state machine, date and schedule math take data in and return data out, with no I/O and no `cloudflare:workers` imports. They are tested in plain Node. I/O lives in a few modules: `repo.ts`, `effects.ts`, `slack/api.ts`, `llm.ts`, `decide.ts`, the keeper and the trackers.
- **One writer.** Every change to an ask goes through `service.ts` and `transition()`. The rules of who may do what exist once, in `RULES`, and the diagram, the Block Kit buttons, the intent options and the tests are all derived from it.
- **Models choose, code decides.** Free text from a model (extraction) is validated against the thread before it is stored. Everything that is a choice among known options (intent, emoji meaning, is this a DM an ask) is asked as a typed question whose options the code built, answered with probabilities, and gated on thresholds tuned by the eval. No model output is executed or posted unvalidated.
- **Ack fast, work in the queue.** Slack gives three seconds. HTTP handlers verify, acknowledge and enqueue or `waitUntil`; every model call runs in the queue consumer or after the ack.
- **Idempotent retries.** Queue jobs dedupe on the tagging message, effects dedupe on their content, alarms recompute from the database, and tracker sync remembers what the tracker last saw.
- **Secrets stay out of files.** Everything account-specific is a secret or a manifest placeholder. The tracked config holds no ids, URLs or tokens.

## Data model

All timestamps are epoch milliseconds. The schema is in `migrations/`; the shapes are `RequestRow`, `AskRow`, `AskEventRow` and `UserPrefsRow` in `src/types.ts`.

- **requests**: one per `@plates` tag and requester → owner pair. Channel and thread, the live message, status (`pending_confirmation`, `confirmed`, `discarded`, `dismissed`), tagger, requester and owner, attribution confidence and reason, the draft asks until confirmed, who confirmed and how.
- **asks**: one thing someone wants from someone else. `holder_id` says whose plate it is on right now, which makes each Home section one indexed query. State (see [state-machine.md](state-machine.md)), type, size and urgency with their source (model or owner), deadlines and their change count, snooze and round counts, source and done links, the latest note, and the tracker reference.
- **ask_events**: the audit log, one row per move with actor, from and to state, note, and the surface it came from (`button`, `home`, `thread_reply`, `reaction`, `dm`, `command`, `system`). Undo reads the previous state from here.
- **user_prefs**: timezone, working hours, digest time, daily reminder cap.
- **proposals**: inferred actions waiting for a yes or no, from a reply or the delivery detector.
- **user_tokens**: encrypted opt-in user tokens. **tracker_sync**: last state mirrored per ask. **user_intros**: who has already seen the welcome.

## Models

| Call | Model | Where | Why this shape |
|---|---|---|---|
| Thread → asks, corrections | `EXTRACT_MODEL` (Claude Sonnet) | queue consumer | Needs written titles, details and attribution; strict tool schema, then validation |
| Clarifying question for an unclear emoji | `FAST_MODEL` (Claude Haiku) | after the ack | Short generated text |
| Reply → action, ambiguity, deadline date, "does this link deliver?" | `DECIDE_MODEL` (System One) | after the ack | Choices among options the state machine built, answered with probabilities |
| Emoji meaning, is this DM an ask | `DECIDE_MODEL` | after the ack / queue | Yes/no with a probability, gated on a threshold |

`DECIDE_API` picks the OpenRouter route (`/v1/systemone` or `/alpha/decisions`); the request and answer shapes are the same. Thresholds live in `src/thresholds.ts`, keyed by model, and come from `npm run eval` (see [development.md](development.md)).

## The logs app

`logs/` is a separate Worker registered as a tail consumer of Plates. Cloudflare hands it every invocation (fetch, queue batch, alarm) with its `console` lines and exceptions. It stores what is worth keeping in its own D1 database and serves two pages, recent invocations and a request's ask history, reading Plates' database through a read-only binding. Access is Cloudflare Access: the Worker verifies the Access JWT against the team's JWKS and fails closed when the two Access values are missing.
