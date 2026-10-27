# Contributing

Plates is small enough to read in an afternoon. [docs/architecture.md](docs/architecture.md) explains how the pieces fit and [docs/development.md](docs/development.md) how to run and test it.

Before opening a pull request:

```sh
npm run typecheck
npm test
npm run local:e2e    # the real Worker in workerd against mock Slack and model servers
```

Conventions worth knowing:

- Pure modules (renderers, parsers, the state machine, date math) take data in and return data out, with no I/O and no `cloudflare:workers` imports, so they run in plain Node tests.
- Every change to an ask goes through `src/domain/service.ts`; it returns effects and `src/effects.ts` executes them.
- Anything the state machine offers is derived from `RULES` in `src/domain/transitions.ts`. `npm run diagram` regenerates `docs/state-machine.md`, and a test fails when it is stale.
- Models only pick among options the code builds; free text from a model is validated in `src/extract/validate.ts` and `src/intent/validate.ts` before it is used.
- A new decision model or a threshold change comes with an eval run (`npm run eval`) and its committed results.
- Nothing account-specific goes in tracked files: no database ids, workspace URLs, tokens or names. `.dev.vars` and `.secrets.env` are ignored by git.
