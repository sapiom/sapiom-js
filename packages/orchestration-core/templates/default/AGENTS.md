# Working in this orchestration

This project defines exactly one Sapiom orchestration in `index.ts`, authored against `@sapiom/orchestration`. Inside a step's `run`, Sapiom capabilities are on `ctx.sapiom` (e.g. `ctx.sapiom.repositories.list()`, `repo.pushFromSandbox(...)`).

## Authoring

- An orchestration is `defineOrchestration({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineOrchestration(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — this project ships a near-complete local suite. Reach for it then; you don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code locally against **stub capabilities**: every `ctx.sapiom.*` call (namespace calls *and* handle methods like `repo.pushFromSandbox`) returns a built-in default, so a workflow runs end-to-end with zero setup. Returns a per-step trace.
- **deploy** — ship it.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

## Stubs (overrides)

`run_local` works with **no stubs** — capabilities return sensible defaults. Add an override only when a step's logic branches on a specific result (e.g. "if `repositories.list()` already contains my repo, skip create"). Put overrides in `.sapiom-dev/stubs.json` (committed and human-reviewable); `run_local` reads it automatically. Shape:

```jsonc
{ "version": 1, "steps": { "<stepName>": { "<capability.path>": <response> | [<response>, ...] } } }
```

Capability paths are namespace methods (`repositories.list`, `agent.coding.run`) or handle methods (`repository.pushFromSandbox`, `sandbox.exec`). A single value answers every call; an array is consumed one element per call.
