# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` —
**dependency-upgrade** — authored against `@sapiom/agent`. It is a scheduled
Dependabot triage: `bump` runs a coding agent to upgrade a repo's dependencies in
a sandbox, `verify` runs the real test suite in that sandbox, `assess` rates the
risk, and only a green build within the risk bar reaches `publish` (which pushes).
Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here:
`ctx.sapiom.repositories.get`, `ctx.sapiom.models.coding.launch`,
`ctx.sapiom.sandboxes.attach` + `box.exec`, `ctx.sapiom.models.run`,
`ctx.sapiom.fileStorage.upload`, and `repo.pushFromSandbox`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.
- **The coding run is async.** `bump` calls `models.coding.launch(...)` and
  returns `pauseUntilSignal(handle, { resumeStep: "verify" })`; the step's static
  `pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "verify" }` annotation must
  match. `verify`'s input is the `CodingResultPayload` — re-attach the sandbox
  from `result.executionEnvironment.id`; live handles don't cross the pause.
- **Green gates the push.** `verify` routes to `rejected` on a failed coding run,
  a failed install, or a non-zero test exit — a push only happens after a green
  build. Don't remove that gate.
- **Never push on a dry run.** The push and the report upload are guarded on
  `dryRun` so `run_local` traces the whole graph offline with no side effects.
  Keep the guard.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to run
it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation (including the
  static `pause` annotation). The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**.
  Pass `{ "repoSlug": "my-app", "dryRun": true }`: the coding launch is stubbed
  and its pause auto-resumes, `verify` synthesizes a green result (no real
  sandbox), and `publish` skips the push + upload — so the full graph traces
  offline, free, with no real repo.
- **deploy**, then **run** — ship it, then perform a real upgrade + test + push.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities + the `dryRun` guard), not the other way around — never
> weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
