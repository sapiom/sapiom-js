# Working in this orchestration

This project defines exactly one Sapiom orchestration in `index.ts`, authored against `@sapiom/orchestration`.

## The loop

1. Edit `index.ts`. An orchestration is `defineOrchestration({ entry, steps })`; each step is `defineStep({ name, next, run })`. Inside `run`, Sapiom capabilities are available pre-auth'd on `ctx.sapiom`.
2. `npm run check` — validate locally (bundles, builds the manifest, checks the step graph). Fast and offline; run it after every edit.
3. `npm run deploy` — ship it.

## Notes for coding agents

- Use `npm run check` as the tight feedback loop — prefer it over reasoning about whether the graph is valid.
- For exact command options, run `sapiom orchestrations --help`, and pass `--json` to any command for machine-readable output. Don't hardcode capability lists or schemas — query them at runtime.
- Keep exactly one `defineOrchestration(...)` export in `index.ts`.
