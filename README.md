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
npx wrangler d1 create plates            # put the id in wrangler.jsonc
npx wrangler queues create plates-extract
npm run db:migrate:remote
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

Then create the Slack app from `slack-manifest.yaml`. Replace `WORKER_URL` first, install it to the workspace, and copy the bot token and signing secret into the secrets above.

## Checks

```sh
npm run typecheck
npm test
```
