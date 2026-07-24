# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Scheduled DB
Snapshot to Insight Report** — authored against `@sapiom/agent`. It has four steps:
`snapshot` (queries a database) → `narrate` (calls `models.run`, the live LLM) →
`chart` (renders an SVG in a sandbox and hosts it in file storage) → `deliver`
(emails the report). Inside a step's `run`, Sapiom capabilities are pre-auth'd on
`ctx.sapiom` (e.g. `ctx.sapiom.database.get(...)`, `ctx.sapiom.models.run(...)`,
`ctx.sapiom.sandboxes.create(...)`, `ctx.sapiom.fileStorage.upload(...)`,
`ctx.sapiom.email.messages.send(...)`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **Keep the edges slim.** The rendered SVG is the only large data here; it is read, hosted, and dropped inside `chart` — only its URL crosses to `deliver`. It never enters `ctx.shared`. Large shared state stalls transitions on the cloud engine.
- **Gate real side effects behind `dryRun`.** The real SQL query runs only on a live run; a dry run reports on `SAMPLE_METRICS` so the graph traces without a database. `deliver` sends email only on a live run with a recipient resolved; otherwise it returns the report as a preview. Keep new external side effects behind the same guard.
- **Read secrets/config at runtime, never persist them.** The recipient and an optional external `DATABASE_URL` are read from the vault (`ctx.sapiom.vault.get("scheduled-db-insight-report", ...)`) at the point of use, not carried through `ctx.shared`.
- **The chart renderer is self-contained on purpose.** `CHART_SCRIPT` is a dependency-free Node script written into the sandbox and run with `node` — no `npm install`, so it's fast and can't fail on a dependency. Swap it for a charting library (Chart.js, Vega, matplotlib) if you want richer output, and add the install to the sandbox command.

## Validating

When you've made a coherent change and want to validate it — the same point you'd
run tests in any project — reach for the local suite. You don't need to run it
after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so the database, `models.run`, the sandbox, and file storage return built-in defaults and the agent runs end-to-end offline for free. Pass `dryRun: true` so `snapshot` uses sample metrics and `deliver` skips the (stubbed) send. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed snapshot + LLM narration + sandbox chart render, and deliver the report. Attach the `schedule` as a cron trigger to run it on a cadence.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities), not the other way around — never weaken or drop real
> logic to shape a local run. The stubbed sandbox returns an empty file read, so
> `chart` degrades to a chart-less report locally — that is expected, not a bug.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). The snapshot timestamp is captured once server-side via Postgres `now()`
and passed forward via `ctx.shared`, rather than recomputed per step. Capture other
non-deterministic values (ids, timestamps) the same way.
