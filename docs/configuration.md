# Configuration

Plates reads everything from the Worker environment (`Env` in `src/types.ts`). Secrets are set with `npx wrangler secret put NAME`; plain variables live under `vars` in `wrangler.jsonc`. For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and fill it in; that file is ignored by git.

Features switch themselves off when their variables are missing, so a minimal install needs only the three required secrets.

## Required

| Name | Kind | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | secret | Verifies every request from Slack (HMAC over the body). Without it every request is rejected with 401. |
| `SLACK_BOT_TOKEN` | secret | Bot token (`xoxb-…`) for posting, reading threads and publishing Home tabs. |
| `OPENROUTER_API_KEY` | secret | One OpenRouter key for every model call: Claude through the Anthropic-compatible Messages endpoint for extraction and clarifying questions, and the decision model for thread-reply intent, emoji meaning and the DM filter. |
| `EXTRACT_MODEL` | var | Model that turns a thread into asks. Default `anthropic/claude-sonnet-5.5`. |
| `FAST_MODEL` | var | Model for short clarifying questions. Default `anthropic/claude-haiku-5.5`. |
| `DECIDE_MODEL` | var | Decision model for the typed questions. Default `typesafe/jev-1.14`. Probability thresholds are keyed by model in `src/thresholds.ts`; run the eval before switching (see [development.md](development.md)). |

## Optional: decision endpoint

| Name | Kind | Purpose |
|---|---|---|
| `DECIDE_API` | var | `systemone` (default, OpenRouter's `/v1/systemone`, TypeSafe-compatible) or `decisions` (`/alpha/decisions`, OpenRouter's own route that fronts every decision model, e.g. `cloudflare/clef-flash`). Same request and answer shape either way. |

## Optional: reading DMs with a user token

Plates can only read conversations the bot is in. With these four set, people can connect their own Slack token from the Home tab so `@plates` works in DMs the bot is not part of. All four must be set together; with any one missing the connect flow is hidden.

| Name | Kind | Purpose |
|---|---|---|
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | secret | From the Slack app's Basic Information page. |
| `TOKEN_ENC_KEY` | secret | AES key that encrypts stored user tokens at rest. 32 random bytes, base64: `openssl rand -base64 32`. Anything else throws at startup. |
| `PUBLIC_URL` | var or secret | Public URL of the deployed Worker, used as the OAuth redirect base (`<PUBLIC_URL>/oauth/callback`, which must be in the manifest's `redirect_urls`). Also sent to OpenRouter as the referer that labels the traffic. |

## Optional: tracker sync

Set `TRACKER` to mirror deliverable asks into an issue tracker. Unset, sync is off. The matching group must be complete.

| Name | Kind | Purpose |
|---|---|---|
| `TRACKER` | var | `jira` or `linear`. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | secret | Jira Cloud connection (`https://yourco.atlassian.net`, the user the API token belongs to, the token, the project). `JIRA_ISSUE_TYPE` is optional, default `Task`. |
| `LINEAR_API_KEY`, `LINEAR_TEAM_ID` | secret | Linear connection. `LINEAR_API_URL` is optional, default `https://api.linear.app/graphql`. |

## Testing only

| Name | Purpose |
|---|---|
| `SLACK_API_URL` | Default `https://slack.com/api`. Points the Slack client at a mock server. |
| `LLM_BASE_URL` | Default `https://openrouter.ai/api`. Points both the Messages and decision routes at a mock server. |

Leave both unset in production. `npm run local:e2e` sets them itself.

## The logs app

`logs/` is a separate Worker with its own configuration (`logs/wrangler.jsonc`). Its secrets are set from that directory:

| Name | Kind | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | secret | `https://<team>.cloudflareaccess.com`, from the Cloudflare Access application that protects the logs page. |
| `ACCESS_AUD` | secret | That application's Audience (AUD) tag. The Worker fails closed: without both Access values every request gets 403. |
| `SLACK_BOT_TOKEN` | secret, optional | Shows people's names instead of Slack ids. |
| `RETENTION_DAYS` | var | How long log rows are kept. Default 14. |
