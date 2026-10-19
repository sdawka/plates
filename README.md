# Plates

Tag `@plates` in Slack when you ask someone for something. It reads the thread, works out who is asking whom for what, and keeps each ask on someone's plate until the requester closes it. Product spec: [PLAN.md](PLAN.md).

## Layout

| Path | What |
|---|---|
| `src/types.ts` | Shared contracts: rows, actions, effects, queue jobs |
| `src/domain/` | `transitions.ts` pure state machine · `service.ts` the only writers · `repo.ts` D1 access |
| `src/extract/` | Thread → asks with Claude (Sonnet for extraction, Haiku for clarifying questions) |
| `src/slack/`, `src/index.ts`, `src/effects.ts` | Signature check, events, buttons/modals, message and DM rendering, effect dispatch |
| `src/home/` | App Home tab (each person's plate) |
| `src/keeper/` | `PlateKeeper` Durable Object per user: snooze wake-ups, daily digest, reminders, unconfirmed nudge/discard |
| `src/intent/` | Thread replies → actions via System One choices built from the state machine (auto-applied with Undo, or "Did you mean"), "looks done?" detector |
| `src/oauth/` | Optional user-token OAuth for reading DMs the bot isn't in |
| `src/trackers/` | Optional Jira Cloud / Linear mirroring of deliverable asks |
| `src/llm.ts` | Shared Claude tool call (strict tools, stop_reason handling) |
| `src/decide.ts` | System One client: typed choice / score / yes-no questions answered with probabilities |
| `migrations/` | D1 schema |

## Setup

```sh
npm install
npx wrangler d1 create plates
```

> **Required:** copy the `database_id` printed by `d1 create` into `d1_databases[0].database_id` in `wrangler.jsonc`, replacing `REPLACE_WITH_D1_ID`. Migrations and deploy fail until you do.

```sh
npx wrangler queues create plates-extract
npx wrangler queues create plates-extract-dlq   # dead-letter queue for jobs that exhaust retries
npm run db:migrate:remote                       # applies migrations/0001_init.sql, 0002_phase2_3.sql, 0003_trackers.sql
npm run deploy                                  # prints the Worker URL
```

1. In `slack-manifest.yaml`, replace every `WORKER_URL` with the deployed URL (e.g. `https://plates.<account>.workers.dev`).
2. At https://api.slack.com/apps → **Create New App** → **From a manifest**, paste it, then **Install to Workspace**.
3. Set the secrets from the app's pages and OpenRouter:

```sh
npx wrangler secret put SLACK_SIGNING_SECRET   # Basic Information → Signing Secret
npx wrangler secret put SLACK_BOT_TOKEN        # OAuth & Permissions → Bot User OAuth Token (xoxb-…)
npx wrangler secret put OPENROUTER_API_KEY     # https://openrouter.ai/settings/keys
```

4. In the app's **Event Subscriptions** page, confirm the request URL shows *Verified* (re-save if it was created before the secret was set).
5. Optional features (DM reading, tracker sync) need the extra secrets below; set `PUBLIC_URL` to the Worker URL for OAuth.

## Configuration

Secrets are set with `wrangler secret put`; plain vars go under `vars` in `wrangler.jsonc`.

### Required

| Name | Kind | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | secret | Verifies requests from Slack. Without it every request is rejected. |
| `SLACK_BOT_TOKEN` | secret | Bot token for posting and reading. Without it Plates can't talk to Slack. |
| `OPENROUTER_API_KEY` | secret | One OpenRouter key for everything: Claude (Anthropic-compatible Messages endpoint) for extraction and clarifying questions, and System One (`/v1/systemone`) for thread-reply intent, emoji meaning and the DM filter. Without it nothing can be extracted. |
| `EXTRACT_MODEL` | var | Model for extraction (default in `wrangler.jsonc`: `anthropic/claude-sonnet-5.5`). |
| `FAST_MODEL` | var | Model for short clarifying questions (default: `anthropic/claude-haiku-5.5`). |
| `DECIDE_MODEL` | var | System One model for the typed decisions (default: `typesafe/jev-1.14`). Uses the same `OPENROUTER_API_KEY`. |

### Optional: reading DMs (user-token OAuth)

All four must be set together. Without any one of them, the "connect" flow is off and Plates can't capture messages from DMs it isn't in.

| Name | Purpose |
|---|---|
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | From the Slack app's Basic Information page. |
| `TOKEN_ENC_KEY` | Encrypts stored user tokens. 32 random bytes, base64: `openssl rand -base64 32`. Anything else throws an error. |
| `PUBLIC_URL` | Public worker URL, e.g. `https://plates.example.workers.dev`; used for the OAuth redirect. |

### Optional: tracker sync

Set `TRACKER` to `jira` or `linear`. Unset, tracker sync is off. The matching group below must then be complete.

| Name | Purpose |
|---|---|
| `TRACKER` | `jira` or `linear`. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | Jira connection. `JIRA_ISSUE_TYPE` is optional (default `Task`). |
| `LINEAR_API_KEY`, `LINEAR_TEAM_ID` | Linear connection. `LINEAR_API_URL` is optional (default `https://api.linear.app/graphql`). |

### Testing only

`SLACK_API_URL` (default `https://slack.com/api`) and `LLM_BASE_URL` (default `https://openrouter.ai/api`, used for both `/v1/messages` and `/v1/systemone`) point Plates at mock servers for local integration runs. Leave them unset in production.

## Checks

```sh
npm run typecheck
npm test            # unit + end-to-end tests against docs-shaped fakes (Slack, Anthropic, Jira, Linear)
npm run local:e2e   # the real Worker in `wrangler dev --local` (D1, Queues, DO alarms) against mock servers
```

`ONLY=a,c npm run local:e2e` runs a subset; `npm run local:mock` starts just the mock servers. `.dev.vars.example` lists every variable for running `wrangler dev` by hand.

## Trying it in Slack

Use two or three people (call them Dana, Bob, Tara). Everything below should also show on each person's **Home** tab.

1. **Invite**: `/invite @plates` in a test channel.
2. **Tag**: Dana writes "@Bob can you send the Q3 numbers by Friday, and review the deck?"; Tara replies in the thread "@plates". Expect "Reading the thread…", then a confirmation naming Dana → Bob, tagged by Tara, with two items.
3. **Confirm rules**: Tara reacts ✅ → nothing (tagger can't confirm). Bob reacts 🤔 → a clarifying question. Bob reacts ✅ → confirmed; Bob gets a DM to accept.
4. **Correct**: on a fresh tag, reply "@plates it's Carol not Bob" or just "it's Carol" → the same confirmation updates, no second one.
5. **Owner actions**: Bob accepts one item later with a deadline (Dana gets a DM), changes the deadline (Dana gets "Thu → Mon"), snoozes the other three times (count shows 💤×3, then the deadline/redirect/reject prompt).
6. **Replies in the thread**: Bob writes "on it" → applied with an Undo button; Undo restores it. Bob writes something ambiguous → "Did you mean …?".
7. **Done and close**: Bob marks done with a link → item lands on Dana's plate as delivered; Dana puts it back, Bob re-delivers, Dana closes.
8. **Reject / send back**: Bob rejects with a reason → on Dana's plate; Dana puts it back.
9. **Other ways in**: `/plates @Bob send the deck by Friday`; the message shortcut **Put on someone's plate** on any message; a DM to the bot.
10. **Unconfirmed**: leave a confirmation unanswered → nudge next working day, then shown as "unconfirmed" on Home.
11. **Reminders**: `/plates settings` → set your timezone and reminder cap; the daily digest arrives at your work start.
12. **Optional**: Connect DMs from Home (needs the OAuth secrets), then tag @plates in a DM it isn't in. With `TRACKER` set, accepted deliverables appear in Jira/Linear.

Also check once on real Cloudflare: two people confirming the same request at the same moment produces one set of items (the guard relies on `changes()` inside a D1 batch, which the tests only exercise on SQLite).

Logs: `npx wrangler tail`. Jobs that fail every retry land in `plates-extract-dlq`.
