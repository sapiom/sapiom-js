# Working in this orchestration

This project defines exactly one Sapiom orchestration in `index.ts` — **Web Research Digest** — authored against `@sapiom/orchestration`. It has two steps: `search` (calls the `web.search` capability) → `summarize` (formats the result into a markdown digest, in-process). Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here, `ctx.sapiom.search.webSearch(...)`).

## Authoring

- An orchestration is `defineOrchestration({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineOrchestration(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- The digest is built in-process from the search result — there's no LLM call. Extend it by adding a step after `summarize` (e.g. store the digest, or fan out one search per subtopic) and declaring the transition in `next`.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so `web.search` returns a built-in default and the workflow runs end-to-end offline for free. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed web search.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_orchestrations_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Capture non-deterministic values (timestamps, ids) once and pass them forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
