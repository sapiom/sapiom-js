# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Durable Backfill / Long-Job Runner** — authored against `@sapiom/agent`. It processes a large dataset in resumable chunks: `plan` resolves the job and loads any prior checkpoint, `process` handles one chunk (in a sandbox, against a dataset `DATABASE_URL`) and rewrites a durable checkpoint before pausing until a heartbeat, and `finalize` writes a manifest and terminates. The run survives restarts because progress is checkpointed to file storage under a stable `jobId`.

## The chunk loop

- **`process`** is a self-loop. After doing a chunk's work and checkpointing, it returns `pauseUntilSignal({ signal: "backfill.heartbeat", resumeStep: "process", correlationId: ctx.executionId })` when work remains, or `goto("finalize", {})` on the last chunk. Its static `pause: { signal, resumeStep: "process" }` annotation is the build-time graph edge that must match the directive; its `next: ["finalize"]` is the exit edge.
- The cursor, processed count, chunk index, and checkpoint file id all live in **`ctx.shared`**, which survives every pause. On resume, `process` reads them back — the heartbeat signal payload itself is ignored (it just wakes the step).
- The **heartbeat** is a cron/schedule firing `backfill.heartbeat` on a cadence. `pauseUntilSignal` is a **runtime primitive, not a metered capability** — a suspended run is not billed while it waits.

## Capabilities

- **`database.get`** resolves the dataset's connection string, which is injected into the chunk sandbox as `DATABASE_URL`.
- **`sandboxes.create` / `exec`** run the per-chunk `command` in a fresh, short-TTL sandbox (torn down in a `finally`, so nothing lingers between chunks).
- **`fileStorage.upload` / `getDownloadUrl` / `list` / `delete`** persist the checkpoint (rotated each chunk), the per-chunk result artifacts, and the final manifest — and read the checkpoint back when resuming.
- **Capabilities come from the types.** What's on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck. Note: `ctx.sapiom.llm` does **not** exist; the LLM path (unused here) is `models.run`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- A step that pauses declares a `pause: { signal, resumeStep }` annotation; a step may both pause and `goto` a `next` target, which is how `process` loops or exits.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation, including the static `pause` annotation.
- **run_local** — runs your **real** step code against **stub capabilities**. Leave `dbHandle` unset (or pass `dryRun: true`) so `process` counts each chunk in-process and skips the sandbox / database / file-storage calls; the local runner auto-resumes each heartbeat pause, so you get the full `plan → process → … → finalize` trace offline for free.
- **deploy**, then **run** — ship it, then perform a real run that pauses between chunks.

### Advancing a paused run in dev

A real `run` pauses after each chunk. To advance it without a schedule, fire the heartbeat via the MCP `signal_workflow` / `workflow_signal` tool:

```json
{
  "signal": "backfill.heartbeat",
  "correlationId": "<executionId of the paused run>"
}
```

To resume an interrupted job, start a new run with the same `jobId` — `plan` reads the checkpoint from file storage and continues.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities + the offline `dryRun` path), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). The `correlationId` is `ctx.executionId` (stable across pauses), so every heartbeat lands on the right run. Progress is advanced in `ctx.shared` and checkpointed to file storage after each chunk, so a resumed or restarted run never reprocesses a completed chunk.
