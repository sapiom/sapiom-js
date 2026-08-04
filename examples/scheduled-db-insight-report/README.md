# Scheduled DB Snapshot to Insight Report

On a cron cadence, snapshot a database, have an LLM spot what's anomalous in it,
write the narrative, run a second query informed by that anomaly, render the
numbers into charts in a sandbox, and email the finished report.

## What it does

```
snapshot  ──▶  detectAnomalies  ──▶  narrate  ──▶  followUp  ──▶  chart  ──▶  deliver
(database)     (models.run)         (models.run)   (database)    (sandbox +   (email)
                                                                  fileStorage)
```

1. **snapshot** — runs a set of read-only SQL queries against a Postgres database
   (`ctx.sapiom.database`) and normalizes each result into a metric: a labeled
   series or a scalar KPI. The defaults introspect the database's own catalog
   (rows per table, table count, size), so it works on any database with no setup.
2. **detectAnomalies** — hands the metrics to an LLM (`ctx.sapiom.models.run`) to
   pick out the single most notable outlier or change, citing the actual figures. A
   deterministic fallback (the largest series point vs. the runner-up) covers an
   empty snapshot or an unusable model response.
3. **narrate** — reads the metrics AND the flagged anomaly and writes a short
   markdown report that leads with it: a summary, bullet insights that cite the
   numbers, and a line on what to watch.
4. **followUp** — recommends and runs a SECOND query, targeted at whatever table
   the anomaly named: Postgres's own activity counters (inserts, updates, deletes,
   scans) for that one table, from `pg_stat_user_tables`. A system-catalog read,
   so it's safe on any Postgres database, not just the seeded demo. No named table
   skips it and says so.
5. **chart** — spins up a sandbox (`ctx.sapiom.sandboxes`), renders the series
   (including the follow-up read, when there is one) into an SVG bar chart with a
   tiny dependency-free script, uploads it to file storage
   (`ctx.sapiom.fileStorage`), and takes a shareable download URL. The sandbox is
   torn down when the step ends; the SVG never enters shared state.
6. **deliver** — emails the report (narrative + anomaly + follow-up + chart link +
   a metrics table). A `dryRun` guard reports on sample metrics and skips the real
   queries and the send; the recipient is ordinary run input, not a secret. The two
   LLM steps run for real either way.

Input: `{ "schedule": "0 8 * * *", "deliverTo": "you@example.com" }`.

- `queries` — an array of `{ name, sql }` to snapshot; each query returns `label`
  and `value` columns. Omit it to introspect the database catalog.
- `dbHandle` — the Sapiom Postgres to snapshot (get-or-created). To report on an
  external database instead, store its connection string under the
  declared `REPORT_DATABASE_URL` credential, which Sapiom injects into the step's
  environment at dispatch.
- `deliverTo` sets the recipient; omit it and the report is returned in the run's
  output instead of emailed
  (`RECIPIENT`).
- `dryRun: true` reports on sample metrics and returns the report without emailing.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; each step inherits
   that authority to call its metered capability.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (capabilities stubbed;
   pass `dryRun: true` to report on sample metrics and skip the real queries and
   delivery, free) → `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` →
   `sapiom_dev_agents_run` (a real, billed snapshot + anomaly detection + LLM
   narration + follow-up query + sandbox chart render, and a delivered report).

4. To run it on a cadence, attach the `schedule` as a cron trigger on the deployed
   agent.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
