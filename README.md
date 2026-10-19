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
| `src/keeper/` | `PlateKeeper` Durable Object per user: snooze wake-ups, daily digest, unconfirmed nudge/discard |
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
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

Then create the Slack app from `slack-manifest.yaml`. Replace `WORKER_URL` first, install it to the workspace, and copy the bot token and signing secret into the secrets above.

## Configuration

Secrets are set with `wrangler secret put`; plain vars go under `vars` in `wrangler.jsonc`.

### Required

| Name | Kind | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | secret | Verifies requests from Slack. Without it every request is rejected. |
| `SLACK_BOT_TOKEN` | secret | Bot token for posting and reading. Without it Plates can't talk to Slack. |
| `ANTHROPIC_API_KEY` | secret | Extraction and clarifying questions. Without it nothing can be extracted. |
| `EXTRACT_MODEL` | var | Model for extraction (default in `wrangler.jsonc`: `claude-sonnet-5-5`). |
| `FAST_MODEL` | var | Model for short clarifying questions (default: `claude-haiku-5-5`). |

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

`SLACK_API_URL` (default `https://slack.com/api`) and `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`) point Plates at mock servers for local integration runs. Leave them unset in production.

## Checks

```sh
npm run typecheck
npm test
```
