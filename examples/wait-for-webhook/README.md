# Wait-for-Webhook

Durable pause/resume around any slow external callback. The run starts a slow
external async job, then **suspends indefinitely at $0** until a webhook/callback
fires — no polling loop, no held worker, no billed idle time — and resumes
exactly where it left off when the external world is ready.

The direct counter to "agents are too expensive to run": a workflow can wait
days on a third-party callback and cost nothing until the signal arrives.

## What it does

```
kickoff  ──(pause: wait for "webhook.callback", $0 while idle)──▶  decide  ─┬─▶  accept  (terminal)
                                                                            └─▶  reject  (terminal)
```

1. **kickoff** — starts the external async job and registers a resume contract
   `{ executionId, signal, correlationId }`, then returns
   `pauseUntilSignal({ signal, resumeStep: "decide", correlationId })`. The run
   suspends here at zero cost.
2. **(paused)** — nothing runs, nothing is billed, for as long as it takes.
3. **decide** (resume target) — its **input IS the callback payload**. An LLM
   (`ctx.sapiom.models.run`) summarizes the payload and branches. Everything set
   before the pause is read back from `ctx.shared`.
4. **accept | reject** — terminal branches keyed off the decision.

Input: `{ "job": { ... }, "config": { "CALLBACK_REGISTER_URL": "...", "CALLBACK_REGISTER_KEY": "..." } }`.
With no `CALLBACK_REGISTER_URL` (or `DRY_RUN` set), `kickoff` runs offline via its
`dryRun` guard.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the `decide` step
   inherits that authority to call the model.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (offline via the `dryRun` guard, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real run that pauses).

## Resuming a paused run in dev

A real `run` pauses at `kickoff` and waits for the `webhook.callback` signal.
Instead of a real webhook, fire it yourself via the MCP `signal_workflow` /
`workflow_signal` tool. The `correlationId` is the paused run's `executionId`,
and the `payload` becomes `decide`'s input:

```json
{
  "signal": "webhook.callback",
  "correlationId": "<executionId of the paused run>",
  "payload": { "status": "succeeded", "result": { "note": "job done" } }
}
```

The run wakes at `decide`, summarizes that `payload`, and branches to `accept`
(a success-looking payload) or `reject` (a `status` of `failed`/`error`/etc.).

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
