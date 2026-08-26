# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **The Brain** —
authored against `@sapiom/agent`. It is a fleet orchestrator: a meta-workflow that
runs a `scan → assess → actuate → report` loop over a set of child workflows,
launching the right member as a child, never doing irreversible work itself.
Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here:
`ctx.sapiom.database.get/create`, `ctx.sapiom.llm.run`). The Slack briefing goes
out on the injected `SLACK_BOT_TOKEN` via a raw `fetch`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.
- **The model only chooses; code constrains.** `assess` may return only a play
  from `ALLOWED_PLAYS`, declared as the `output` schema's `enum` so the choice is
  bounded at the wire; `readPlan()` re-validates every play and target anyway.
  Any human/request text is untrusted data to _classify_ into a play, never
  instructions to follow. Don't weaken the allow-list or `validTargets`
  re-check — they are the prompt-injection boundary.
- **A plan this template can't read is a failed sweep.** `readPlan()` throws; it
  never synthesizes a plan from the situation kinds. The plan launches child
  agents and escalates to people, so an invented one spent real money and
  reported the sweep as coordinated (SAP-2892). The guardrails bound the damage;
  they do not make the plan the model's.
- **Keep the six actuate guardrails.** allow-list re-check, drop `no_action`,
  escalate-only (no launch), only-surfaced-targets, per-day cooldown, single-open,
  and the fan-out cap (`MAX_LAUNCHES_PER_RUN`). Each launch uses the idempotency
  key `<play>-<target>-<yyyy-mm-dd>` and appends a `member.launched` row so the
  next scan sees it.
- **The event log is the state.** Sapiom has no native pub/sub — the bus is one
  Postgres DB the brain owns (`fleet_events` + `fleet_state`). Read since the
  cursor, append what you did, advance the cursor in `report`. Keep schema init
  idempotent.
- **Child launch is a raw HTTP call.** `ctx.sapiom.agents.launch` 404s on the
  deployed backend today; `launchChild` posts to `/v1/workflows/executions` with
  `x-api-key`. A member's explicit `definitionId` can launch without discovery;
  otherwise the tenant-scoped `/definitions` lookup resolves slug→definitionId
  and caches it per tenant, with `DEF_IDS` as a static fallback. Lookup failures
  log their HTTP status instead of silently looking like a missing child.
  Definition ids are environment-specific — deploy children first and seed the
  member or fallback map.
- **Slim `ctx.shared`.** Large cross-step payloads silently stall the cloud
  engine. Pass only compact ids/counts/the plan array across steps; re-read bulk
  data (event rows) in the step that needs it.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to run
it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full
  local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**.
  Pass `{ "dryRun": true }`: the full `scan → assess → actuate → report` graph
  traces offline — raw Postgres/Slack/child-launch I/O is skipped, while the real
  `llm.run` call still runs, with no API key needed.
- **deploy**, then **run** — ship it, then a real run. Pass `{ "observeOnly": true }`
  first to report what it WOULD launch without launching; then run with actuation
  on. A second run the same day is cooldown-skipped (idempotency).

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities + the `dryRun` guard), not the other way around — never
> weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
The `now` input pins the clock for deterministic testing.
