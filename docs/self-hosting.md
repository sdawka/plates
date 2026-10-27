# Self-hosting Plates

Plates is one Cloudflare Worker (plus an optional logs Worker) and one Slack app, installed in one workspace. Nothing in the repository is tied to an account: the database and queues are created on first deploy, and everything account-specific is a secret or a value you paste into the Slack manifest.

## What you need

- A Cloudflare account with Workers, D1, Queues and Durable Objects. Queues need the Workers Paid plan.
- A Slack workspace where you can create and install a custom app.
- An [OpenRouter](https://openrouter.ai) API key. Every model call goes through OpenRouter: Claude for extraction and clarifying questions, and a System One decision model (TypeSafe Jev by default) for the yes/no and multiple-choice questions.
- Node 24 or newer and `npm`.

## 1. Deploy the Worker

```sh
git clone https://github.com/sdawka/plates.git
cd plates
npm install
npx wrangler login
npx wrangler queues create plates-extract
npx wrangler queues create plates-extract-dlq     # dead-letter queue for jobs that exhaust retries
npm run deploy
```

`wrangler.jsonc` names the D1 database (`plates`) without an id, so the first `npm run deploy` creates it in your account and links it; later deploys reuse it. Then apply the schema:

```sh
npm run db:migrate:remote
```

The deploy prints the Worker URL, `https://plates.<your-subdomain>.workers.dev`. Keep it for the next step.

**Logs app.** `wrangler.jsonc` lists `plates-logs` as a tail consumer: a second Worker that keeps every invocation's logs and serves them behind Cloudflare Access. Deploy it before the first `npm run deploy`, from the `logs/` directory (`npx wrangler deploy`, then `npx wrangler d1 migrations apply plates-logs --remote`; the rest is under [Operations](#operations)). If you do not want it, delete the `tail_consumers` line from `wrangler.jsonc`; a deploy fails when the named consumer does not exist.

## 2. Create the Slack app

1. In `slack-manifest.yaml`, replace every `WORKER_URL` with the Worker URL from step 1 (hostname only, no trailing slash; the paths are already there).
2. Go to https://api.slack.com/apps, **Create New App**, **From a manifest**, pick the workspace, paste the file, create, then **Install to Workspace**.
3. Optional: under **Basic Information → Display Information**, upload `assets/icon.png` as the app icon.
4. Set the three required secrets:

```sh
npx wrangler secret put SLACK_SIGNING_SECRET   # Basic Information -> App Credentials -> Signing Secret
npx wrangler secret put SLACK_BOT_TOKEN        # OAuth & Permissions -> Bot User OAuth Token (xoxb-…)
npx wrangler secret put OPENROUTER_API_KEY     # https://openrouter.ai/settings/keys
```

5. In the app's **Event Subscriptions** page, confirm the request URL shows *Verified*. If the app was created before the signing secret was set, re-save the URL.
6. Invite the bot to a channel and run the [walkthrough](walkthrough.md).

The manifest asks for `users:read.email` only so that tracker sync can match Slack users to Jira or Linear accounts. Remove it from the manifest if you will not use trackers.

## 3. Optional features

Each feature is off until its variables are set. [configuration.md](configuration.md) has the full reference.

**Reading DMs the bot is not in.** Slack only lets a bot read conversations it is part of. With a user-token OAuth flow, each person can connect their own token from the Home tab and `@plates` then works in their DMs. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `TOKEN_ENC_KEY` (`openssl rand -base64 32`) and `PUBLIC_URL` (the Worker URL). Tokens are encrypted at rest with `TOKEN_ENC_KEY`. The manifest already lists `<WORKER_URL>/oauth/callback` as the redirect URL and the user scopes.

**Tracker sync.** Set `TRACKER=jira` or `TRACKER=linear` plus the matching credentials. Deliverable asks become issues when accepted; state, deadline and assignee follow the ask.

## 4. Updating

```sh
git pull
npm install
npm run db:migrate:remote    # applies only new files in migrations/
npm run deploy
```

When `slack-manifest.yaml` changes (new scopes, events or the agent view), open the app at https://api.slack.com/apps, **App Manifest**, paste the new file (with your URL), save, then **Install App → Reinstall to Workspace** so the new scopes are granted.

A model change (`EXTRACT_MODEL`, `FAST_MODEL`, `DECIDE_MODEL`, `DECIDE_API`) is an edit to `vars` in `wrangler.jsonc` and a deploy. Before changing `DECIDE_MODEL`, run the eval described in [development.md](development.md): probabilities are not comparable across decision models, and each model needs its own thresholds in `src/thresholds.ts`.

## Operations

**Logs.** `npx wrangler tail` streams live logs. Plates writes one JSON line per Slack event, click, command, queue job and model call: ids and kinds, never message text.

**The logs app** (`logs/`) is a Tail Worker: Cloudflare hands it every Plates invocation (HTTP request, queue batch, alarm) with its log lines and exceptions. It keeps them in its own D1 database for `RETENTION_DAYS` (14) and serves a page of recent requests and each ask's history. It only opens behind Cloudflare Access and checks the Access token itself, so it stays locked (403) until Access is configured.

```sh
cd logs
npx wrangler deploy                                   # creates the plates-logs database and links plates read-only
npx wrangler d1 migrations apply plates-logs --remote
```

Then, in the Cloudflare dashboard: **Workers & Pages** → `plates-logs` → **Settings** → **Domains & Routes** → `workers.dev` → **Enable Cloudflare Access**, and set the policy to whoever may read logs. The dialog shows the **audience (AUD) tag** and the team domain. Store both as secrets, from the `logs/` directory:

```sh
npx wrangler secret put ACCESS_TEAM_DOMAIN    # https://<team>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD            # the AUD tag
npx wrangler secret put SLACK_BOT_TOKEN       # optional: names instead of Slack ids
```

**Failed jobs.** Extraction runs in a queue with three retries. A job that fails every retry lands in `plates-extract-dlq`, and the thread gets a short failure note instead of a stale "Reading the thread…".

**Database.** `npx wrangler d1 execute plates --remote --command "SELECT count(*) FROM asks"` for ad-hoc queries. There is no admin UI; the logs app shows requests and ask histories.

## Data and privacy

What Plates stores, so you can answer the question before someone asks it:

- **D1 (`plates`)**: requests (channel and thread ids, who tagged, requester and owner ids, the draft asks until confirmed), asks (title, a short detail, type, size, state, deadlines, the latest note or reason, links people attached as done or source), an event log per ask (who did what, with the note they typed), per-user preferences (timezone, working hours, digest time, reminder cap), pending "Did you mean" proposals, tracker sync state, and the encrypted user tokens of people who connected DM access.
- **Not stored**: full message bodies. Extraction reads the thread at capture time and keeps titles, details and permalinks, not the conversation.
- **Logs**: ids, kinds, timings and exception messages. No message text. Kept 14 days by the logs app, and by Cloudflare's own observability for its retention.
- **Third parties**: thread text is sent to OpenRouter (and through it to the model vendors) for extraction and decisions. Nothing is sent to Jira or Linear unless `TRACKER` is set.

Deleting the D1 database deletes everything Plates knows.
