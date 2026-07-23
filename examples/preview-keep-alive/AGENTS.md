# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Preview
Keep-Alive** — authored against `@sapiom/agent`. It is a self-healing cron
heartbeat: `check` probes a preview's health; if it is down, `heal` re-attaches
the sandbox and calls `deployPreview` (source `fs`) to rebuild + restart the
uploaded code at the same stable URL. Inside a step's `run`, Sapiom capabilities
are pre-auth'd on `ctx.sapiom` (here: `ctx.sapiom.sandboxes.attach`,
`box.deployPreview`, `ctx.sapiom.database.get`, `ctx.sapiom.vault.get`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.
- **Heal only on failure.** `check` routes to `heal` only when the probe fails;
  the healthy path is a terminal no-op. Relaunching a live app would stack a
  second process and EADDRINUSE the port — don't remove that guard.
- **Never bake secrets into the schedule.** A secret the app needs at start is
  named in `vaultInject` (`ENV_VAR -> vaultKey`) and read from the vault at
  runtime via `ctx.sapiom.vault.get(vaultRef, key)`. The schedule input carries
  the reference, never the value.
- **One definition, many previews.** The target is per-run via the schedule
  input (`sandboxName`, `url`, `start`, …), so one deploy keeps N previews alive.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to run
it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full
  local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**.
  Pass `{ "dryRun": true, "sandboxName": "my-app", "url": "https://…", "start": "node server.js" }`:
  `check` skips the network probe and `heal` assembles the relaunch env, then
  reports the injected env keys (names only) **without** calling `deployPreview`
  — so the full heal branch traces offline, free, with no real key.
- **deploy**, then **run** — ship it, then perform a real relaunch against a down
  sandbox.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities + the `dryRun` guard), not the other way around — never
> weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
