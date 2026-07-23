# Error / Log Triage Digest

Ingest a stream of errors, cluster and summarize them with an LLM, dedupe against
a database so you only hear about what's new, and email a daily digest. The
scheduled-or-pushed, deduped sibling of a plain alert forwarder.

## What it does

```
collect  ──▶  triage  ──▶  dedupe  ──▶  digest  (terminal)
(pause/pull)   (models.run)  (database)   (email)
```

1. **collect** — gathers the error batch. It takes one directly as `errors`, GETs
   one from a `pullUrl`, or — with `webhook: true` and no batch yet — **pauses at
   $0** via `pauseUntilSignal` until your pipeline pushes one as the
   `errors.pushed` signal. No polling loop, no billed idle.
2. **triage** — hands the raw errors to an LLM (`ctx.sapiom.models.run` — the
   live x402-served model) to cluster them into a handful of distinct issues,
   each with a **stable fingerprint** (volatile ids, timestamps, and line numbers
   stripped), a title, a severity, and an occurrence count.
3. **dedupe** — looks each fingerprint up in a Postgres table the digest owns
   (`ctx.sapiom.database`). Never-seen fingerprints are **new**; the rest are
   **recurring**, with their running totals updated. This is what stops a daily
   digest from re-alerting on the same known error every morning.
4. **digest** — writes a markdown digest (new issues first, recurring below) and
   emails it. A `dryRun` computes the digest but skips the DB writes and the real
   send; the recipient is read from the Sapiom vault at runtime, never persisted.

Input: `{ "errors": [{ "message": "...", "level": "error", "service": "checkout" }], "deliverTo": "you@example.com", "schedule": "0 8 * * *" }`.

- `errors` (or `pullUrl`, or the `errors.pushed` webhook) supplies the batch.
- `deliverTo` sets the recipient; omit it to use the vault-configured default.
- `dryRun: true` returns the digest as a preview without writing or sending.

### Two ways in

- **Scheduled pull** — attach `schedule` as a cron trigger; the run pulls a batch
  from `pullUrl` (or is handed one directly) and digests it.
- **Webhook push** — run with `webhook: true`; the run suspends until your
  pipeline pushes a batch with the `errors.pushed` signal, then resumes and
  digests it.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; each step inherits
   that authority to call its metered capability.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (capabilities
   stubbed; pass `dryRun: true` so the DB and delivery are skipped, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`
   (a real, billed LLM triage that writes to the dedup store and delivers the
   digest).

4. To run it on a cadence, attach the `schedule` as a cron trigger on the
   deployed agent. To push errors in instead, run with `webhook: true` and fire
   the `errors.pushed` signal with the `workflow_signal` MCP tool, passing
   `{ "errors": [ ... ] }`.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
