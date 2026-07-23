# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Scheduled
Compliance Audit + Attestation** — authored against `@sapiom/agent`. It has six
steps: `collect` (calls `web.scrape`) → `audit` (calls `models.run`, the live
LLM) → `review` (pauses on the `attestation.signoff` signal) → `onSignoff`
(reads the decision) → `archive` (calls `fileStorage.upload`) or `rejected`.
Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (e.g.
`ctx.sapiom.search.scrape(...)`, `ctx.sapiom.models.run(...)`,
`ctx.sapiom.fileStorage.upload(...)`).

It composes the scheduled-collect-and-curate shape of `scheduled-research-brief`
with the pause-for-a-human gate of `human-in-the-loop`. The gate here protects
the **attestation archive**: nothing is filed until a person explicitly signs off.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.
- **The durable pause is a primitive, not a capability.** `review` declares a
  static `pause: { signal, resumeStep }` edge AND returns
  `pauseUntilSignal({ signal, resumeStep, correlationId: ctx.executionId })`. The
  resume target (`onSignoff`) receives the signal payload as its `run` input.
- **Gate real side effects behind `dryRun`.** `archive` uploads the attestation
  only on a live run with `dryRun` off; otherwise it returns the computed
  attestation as a preview. The upload's presigned PUT is a raw `fetch` (not a
  stubbed capability), so it MUST stay behind this guard or it would hit the
  network during `run_local`.
- **Safe by default on resume.** Only an explicit `approve` archives; a resume
  with no decision (what `run_local` sends) takes the `rejected` branch. This is
  deliberate — an attestation asserts a human reviewed and signed off, so it is
  never filed without one.
- **Keep the edges slim.** The scraped bodies are the only large data; they stay
  bounded (truncated, capped count) and die at the `audit` boundary — they never
  enter `ctx.shared`. Large shared state stalls transitions on the cloud engine.

## Validating

When you've made a coherent change and want to validate it — the same point you'd
run tests in any project — reach for the local suite. You don't need to run it
after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full
  local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so
  `web.scrape` / `models.run` / `fileStorage.upload` return built-in defaults and
  the agent runs end-to-end offline for free. The pause is auto-resumed with no
  decision, so the offline trace lands on `rejected`; pass `dryRun: true` so
  `archive` would skip the (stubbed) upload if you drive the approve path with a
  real signal. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed collect + policy
  check that pauses for sign-off. Fire the `attestation.signoff` signal to resume
  (see `README.md`). Attach the `schedule` as a cron trigger to run it on a cadence.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities), not the other way around — never weaken or drop real
> logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Collection channel: scrape vs. sandbox

This template collects state over the network with `web.scrape` — the simplest
way to read a config page, a status endpoint, or a published policy doc. To audit
state that only exists inside a running environment — files on disk, a service's
live config, a command's output — swap the scrape in `collect` for a sandbox
attach + exec, e.g. `ctx.sapiom.sandboxes.attach(id)` then run a read-only command
and capture stdout as the collected evidence. Keep the same per-item
degrade-on-failure loop and the `MAX_BODY_CHARS` bound so a body never lands in
shared state.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). The audit timestamp is captured once in `collect` and carried forward via
`ctx.shared` rather than recomputed downstream — do the same for any id or clock
value a later step depends on.
