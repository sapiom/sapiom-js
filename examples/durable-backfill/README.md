# Durable Backfill / Long-Job Runner

Process a huge dataset in resumable chunks, checkpointing progress to durable
storage and surviving restarts via a cron heartbeat. A pure durability showcase:
instead of one long-held worker grinding through a million rows (and dying
halfway with nothing to show), it walks the dataset one bounded chunk at a time,
writes down where it is after each chunk, and **suspends at $0** between chunks
until a heartbeat wakes it for the next one.

## What it does

```
plan  ──▶  process  ──(checkpoint, then pause: wait for "backfill.heartbeat", $0 while idle)──╮
           ▲                                                                                  │
           ╰──────────────────────── resume on the heartbeat ─────────────────────────────────╯
           │
           ╰─(no work left)─▶  finalize  (terminal)
```

1. **plan** — resolve the job (dataset `total`, `chunkSize`, a stable `jobId`).
   If a durable checkpoint already exists for that `jobId`, resume from it;
   otherwise start at zero.
2. **process** — handle the current chunk. The real work runs in a sandbox that
   gets the dataset's `DATABASE_URL` (from the `database` capability) and the
   chunk range (`CHUNK_OFFSET` / `CHUNK_LIMIT`) injected as env. It saves a
   per-chunk result file and rewrites the checkpoint (`fileStorage`), advances
   the cursor, then pauses until the next heartbeat — or, once the last chunk is
   done, goes straight to `finalize`.
3. **(paused)** — nothing runs, nothing is billed, until the heartbeat fires.
4. **finalize** — write a run manifest and terminate with a summary.

Restart survival has two layers. Within one run, the cursor lives in
`ctx.shared` and survives every pause. Across a full teardown, the checkpoint
lives in file storage keyed by `jobId`, so a brand-new run started with the same
`jobId` reads it in `plan` and picks up mid-dataset.

Input: `{ "total": 100000, "chunkSize": 5000, "jobId": "users-backfill", "dbHandle": "users-db", "command": "node backfill.js" }`.
With no `dbHandle` (or `dryRun` set), `process` counts each chunk in-process and
skips the sandbox / database / file-storage calls.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the deployed run
   inherits that authority to provision sandboxes and databases and to read and
   write file storage.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (offline, free — leave `dbHandle` unset or pass `dryRun: true`) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` →
   `sapiom_dev_agents_run` (a real run that pauses between chunks).

## Advancing a paused run in dev

A deployed run processes one chunk, then pauses for the `backfill.heartbeat`
signal. In production a schedule fires that signal on a cadence; in dev, fire it
yourself via the MCP `signal_workflow` / `workflow_signal` tool. The
`correlationId` is the paused run's `executionId`:

```json
{
  "signal": "backfill.heartbeat",
  "correlationId": "<executionId of the paused run>"
}
```

Each heartbeat processes and checkpoints one more chunk. To resume an
interrupted job, start a new run with the same `jobId` — `plan` reads the
checkpoint and continues from the last completed chunk.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
