# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Natural-Language DB
Query Endpoint**, authored against `@sapiom/agent`. It provisions a live HTTP
endpoint AND proves the pipeline for real: `validate` → `resolve` (`database.get`,
plus seeding the demo database if needed) → `plan` (a fixed query on the
zero-setup path, else `models.run`) → `guard` (read-only check) → `execute` (runs
the guarded SQL for real, the zero-setup artifact) → `deploy`
(`sandboxes.deployPreview`) → terminal `deployed` / `deploy_failed` /
`endpoint_skipped` / `query_failed` / `rejected`. Inside a step's `run`, Sapiom
capabilities are pre-auth'd on `ctx.sapiom`.

The deployed endpoint's code is `SERVER_SOURCE` — a self-contained ESM server that
re-runs translate → guard → execute per request. It reads all config from env
(injected at `deploy` time), so it has no build-time interpolation.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- The guardrail lives in two places on purpose: `guardReadOnly` in `index.ts` (the `guard` step, checked before `execute` runs the SQL for real) and an identical copy embedded in `SERVER_SOURCE` (the per-request check). `ensureLimit` is likewise duplicated — the real TS function `execute` uses, and the copy inside `SERVER_SOURCE`. Keep each pair in sync if you change one.
- The real safety boundary is running inside a `READ ONLY` transaction — both in `execute` (via `postgres`'s `sql.begin("read only", ...)`) and in the deployed server (`BEGIN TRANSACTION READ ONLY`). The keyword checks are belt-and-suspenders in front of it. Don't weaken either transaction.
- `execute` is the only step that runs the guarded SQL against a LIVE database from the orchestrator itself (not just inside the sandboxed server) — on the zero-setup path that's the seeded demo database; on a custom run it may be the caller's own. Treat it with the same care as the server's per-request path.

## Validating

When you've made a coherent change and want to validate it — the same point you'd
run tests in any project — reach for the local suite. You don't need to run it after
every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**. On defaults, `plan` never calls the model at all (the zero-setup path uses the fixed built-in SQL), so `guard` passes — but `database.get` is stubbed to an unreachable connection string, so `execute`'s real query fails and the run legibly reaches `query_failed`, a demo of the query-execution boundary rather than the guardrail. To trace `plan`'s LLM path (a custom `sampleQuestion`, or a custom `dbHandle`) pass a `models.run` stub override:

  ```json
  { "version": 1, "steps": { "plan": { "models.run": { "output": "SELECT count(*) FROM users" } } } }
  ```

  To trace the whole graph offline with no live connection at all, pass `{ "dryRun": true }`: `execute` reports fixed sample rows instead of querying, and `deploy` assembles the env (keys only, never values) and reports the generated server without calling `deployPreview`.
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
