# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Natural-Language DB
Query Endpoint**, authored against `@sapiom/agent`. It provisions a live HTTP
endpoint: `validate` → `resolve` (`database.get`) → `plan` (`models.run`) → `guard`
(read-only check) → `deploy` (`vault.get` + `sandboxes.deployPreview`) → terminal
`deployed` / `deploy_failed` / `rejected`. Inside a step's `run`, Sapiom
capabilities are pre-auth'd on `ctx.sapiom`.

The deployed endpoint's code is `SERVER_SOURCE` — a self-contained ESM server that
re-runs translate → guard → execute per request. It reads all config from env
(injected at `deploy` time), so it has no build-time interpolation.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- The guardrail lives in two places on purpose: `guardReadOnly` in `index.ts` (the `guard` step's preview) and an identical copy embedded in `SERVER_SOURCE` (the per-request check). Keep them in sync if you change one.
- The real safety boundary is `BEGIN TRANSACTION READ ONLY` in the server — the keyword checks are belt-and-suspenders in front of it. Don't weaken the transaction.

## Validating

When you've made a coherent change and want to validate it — the same point you'd
run tests in any project — reach for the local suite. You don't need to run it after
every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**. The `models.run` stub returns a non-SQL placeholder, so on defaults `guard` routes to `rejected` (a legible demo of the guardrail refusing junk). To trace the deploy branch, pass `{ "dryRun": true }` *and* a stub override so `plan` returns real SQL:

  ```json
  { "version": 1, "steps": { "plan": { "models.run": { "output": "SELECT count(*) FROM users" } } } }
  ```

  Under `dryRun`, `deploy` assembles the env (keys only, never values) and reports the generated server without calling `deployPreview`.
- **deploy**, then **run** — ship it, then a real run stands up the endpoint at a stable URL. Hit it with `POST /query { "question": "…" }`.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities), not the other way around — never weaken or drop real
> logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools
(`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
