# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Scheduled DB
Snapshot to Insight Report** — authored against `@sapiom/agent`. It has six steps:
`snapshot` (queries a database) → `detectAnomalies` (calls `llm.run` to flag the
one outlier worth attention) → `narrate` (calls `llm.run` again to write the
report around it) → `followUp` (queries the database a second time, targeted at
whatever table the anomaly named) → `chart` (renders an SVG in a sandbox and hosts
it in file storage) → `deliver` (emails the report). Inside a step's `run`, Sapiom
capabilities are pre-auth'd on `ctx.sapiom` (e.g. `ctx.sapiom.database.get(...)`,
`ctx.sapiom.llm.run(...)`, `ctx.sapiom.sandboxes.create(...)`,
`ctx.sapiom.fileStorage.upload(...)`, `ctx.sapiom.email.messages.send(...)`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **Keep the edges slim.** The rendered SVG is the only large data here; it is read, hosted, and dropped inside `chart` — only its URL crosses to `deliver`. It never enters `ctx.shared`. Large shared state stalls transitions on the cloud engine.
- **Gate real side effects behind `dryRun`, not the model calls.** The real SQL queries (`snapshot`, `followUp`) run only on a live run; a dry run reports on `SAMPLE_METRICS` and a sample follow-up read so the graph traces without a database. `deliver` sends email only on a live run with a recipient resolved; otherwise it returns the report as a preview. `detectAnomalies` and `narrate` call `llm.run` for real either way — a model call is the world's response to whatever metrics are on hand, sample or not, so it isn't gated behind `dryRun`. Keep new external side effects behind the same DB/email guard.
- **A model's free text never becomes a query parameter unchecked.** `detectAnomalies` returns an `Anomaly` with a `table` field the model chose; `coerceAnomaly` only trusts it when it names a label the snapshot's OWN metrics actually returned (see `knownLabels` in `coerceAnomaly`). `followUp` then reads that table with a parameterized query (`sql.unsafe(FOLLOW_UP_SQL, [table])`) — never string-interpolated — against `pg_stat_user_tables`, a system catalog, so it's safe even if the trust check somehow let something odd through.
- **Config is not a secret; a DSN is.** The recipient is ordinary run input (`deliverTo`, declared as a `settings[]` entry). A connection string to your own database is a real credential, declared as `REPORT_DATABASE_URL` under `requiredSecrets` and read from `process.env` at the point of use — never carried through `ctx.shared`.
- **Seed only what you read.** The declared `db-insight-demo` Postgres is seeded from `seed.sql` because this template REPORTS ON a database and never writes to one. Never seed a table that is a template's own output.
- **The chart renderer is self-contained on purpose.** `CHART_SCRIPT` is a dependency-free Node script written into the sandbox and run with `node` — no `npm install`, so it's fast and can't fail on a dependency. Swap it for a charting library (Chart.js, Vega, matplotlib) if you want richer output, and add the install to the sandbox command.

## Validating

When you've made a coherent change and want to validate it — the same point you'd
run tests in any project — reach for the local suite. You don't need to run it
after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so the database, `llm.run`, the sandbox, and file storage return built-in defaults and the agent runs end-to-end offline for free. Pass `dryRun: true` so `snapshot`/`followUp` use sample data and `deliver` skips the (stubbed) send. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed snapshot + anomaly detection + LLM narration + follow-up query + sandbox chart render, and deliver the report. Attach the `schedule` as a cron trigger to run it on a cadence.

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
