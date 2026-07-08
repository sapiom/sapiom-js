# Working in this orchestration

This project defines exactly one Sapiom orchestration in `index.ts` — **Hello Workflow** — authored against `@sapiom/orchestration`. It's the minimal definition: one terminal `greet` step, no capabilities. `greet` validates an optional `name` input and returns `{ greeting: "Hello, <name>!" }`. Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (this template doesn't use any yet).

## Authoring

- An orchestration is `defineOrchestration({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineOrchestration(...)` export.
- **Capabilities come from the types.** When you reach for one, what's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- To grow this into something real, add a step and declare the transition in the current step's `next` (an undeclared transition is a compile error). The Web Research Digest template is the next step up — one metered capability, an obvious output.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code end-to-end and returns a per-step trace. This template has no capabilities, so `run_local` and a real `run` behave identically.
- **deploy**, then **run** — ship it, then run it for real.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_orchestrations_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Capture non-deterministic values (timestamps, ids) once and pass them forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
