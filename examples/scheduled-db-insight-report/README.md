# Scheduled DB Snapshot to Insight Report

On a cron cadence, snapshot a database, write the narrative with an LLM, render
the numbers into charts in a sandbox, and email the finished report.

## What it does

```
snapshot  ──▶  narrate  ──▶  chart  ──▶  deliver  (terminal)
(database)    (models.run)   (sandbox +   (email)
                             fileStorage)
```

1. **snapshot** — runs a set of read-only SQL queries against a Postgres database
   (`ctx.sapiom.database`) and normalizes each result into a metric: a labeled
   series or a scalar KPI. The defaults introspect the database's own catalog
   (rows per table, table count, size), so it works on any database with no setup.
2. **narrate** — hands the metrics to an LLM (`ctx.sapiom.models.run` — the live
   x402-served model) to write a short markdown report: a summary, bullet insights
   that cite the numbers, and a line on what to watch.
3. **chart** — spins up a sandbox (`ctx.sapiom.sandboxes`), renders the series into
   an SVG bar chart with a tiny dependency-free script, uploads it to file storage
   (`ctx.sapiom.fileStorage`), and takes a shareable download URL. The sandbox is
   torn down when the step ends; the SVG never enters shared state.
4. **deliver** — emails the report (narrative + chart link + a metrics table). A
   `dryRun` guard reports on sample metrics and skips the real send; the recipient
   is read from the Sapiom vault at runtime, never persisted.

Input: `{ "schedule": "0 8 * * *", "deliverTo": "you@example.com" }`.

- `queries` — an array of `{ name, sql }` to snapshot; each query returns `label`
  and `value` columns. Omit it to introspect the database catalog.
- `dbHandle` — the Sapiom Postgres to snapshot (get-or-created). To report on an
  external database instead, store its connection string under the
  `scheduled-db-insight-report` vault ref (key `DATABASE_URL`).
- `deliverTo` sets the recipient; omit it to use the vault-configured default
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
   pass `dryRun: true` to report on sample metrics and skip delivery, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`
   (a real, billed snapshot + LLM narration + sandbox chart render, and a
   delivered report).

4. To run it on a cadence, attach the `schedule` as a cron trigger on the deployed
   agent.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
