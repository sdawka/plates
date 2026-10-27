# Plates

Plates is a Slack app you tag when you ask someone for something. It reads the thread, works out who is asking whom for what, and keeps each ask on someone's plate until the requester closes it. It runs on Cloudflare Workers and talks to Claude and a System One decision model through OpenRouter.

- **Capture**: `@plates` in a thread, `/plates @bob send the deck by Friday`, a message shortcut, or a DM to the bot. Claude extracts the asks, Plates posts a confirmation naming requester and owner.
- **Track**: every ask is on exactly one person's plate, with a state machine that says who can do what. Owners accept, snooze, deliver, reject or send back. Only the requester can close or withdraw.
- **Act by talking**: replies in the thread ("on it", "I'll get to it Thursday", "here it is: link") become actions, applied with Undo or offered as "Did you mean".
- **Keep it visible**: a Home tab per person, a daily digest, deadline reminders with a daily cap, and optional mirroring to Jira or Linear.

## Self-hosting

You need a Cloudflare account (Workers, D1, Queues, Durable Objects), a Slack workspace where you can install a custom app, and an OpenRouter key. The whole install is a few commands plus pasting a manifest into Slack. Follow [docs/self-hosting.md](docs/self-hosting.md).

```sh
npm install
npm run typecheck && npm test   # optional, runs without any credentials
npm run deploy                  # creates the database and queues on first deploy
```

## Documentation

| Doc | What it covers |
|---|---|
| [docs/self-hosting.md](docs/self-hosting.md) | Install on your own Cloudflare account and Slack workspace, optional features, updating, operations |
| [docs/configuration.md](docs/configuration.md) | Every secret and variable, required and optional |
| [docs/walkthrough.md](docs/walkthrough.md) | A scripted tour in Slack to check an install end to end |
| [docs/architecture.md](docs/architecture.md) | Components, request flow, module layout, data model, design rules |
| [docs/development.md](docs/development.md) | Tests, the local end-to-end run, the decision-model eval, conventions |
| [docs/product.md](docs/product.md) | The product spec: problems, flows, decisions log |
| [docs/state-machine.md](docs/state-machine.md) | The ask state machine, generated from the code |
| [docs/clairic-spike.md](docs/clairic-spike.md) | Research: Cloudflare's Clairic extraction model measured against the current date extraction |

## Status

Plates is built for a single Slack workspace: one install, one set of secrets, no tenancy or billing. It is in daily use but the model layer is young; see the eval in [docs/development.md](docs/development.md) before changing a model or a threshold.

## License

[MIT](LICENSE).
