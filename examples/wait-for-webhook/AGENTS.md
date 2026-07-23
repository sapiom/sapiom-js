# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Wait-for-Webhook** — authored against `@sapiom/agent`. It demonstrates durable pause/resume: `kickoff` starts a slow external async job, registers a resume contract, and returns `pauseUntilSignal(...)`; the run then suspends at $0 until an external callback fires the signal; `decide` (the resume target) receives the callback payload as its input, summarizes it with `ctx.sapiom.models.run`, and branches to `accept` or `reject`.

## The pause/resume spine

- **`kickoff`** registers `{ executionId, signal, correlationId: ctx.executionId }` with the external job, then returns `pauseUntilSignal({ signal, resumeStep: "decide", correlationId: ctx.executionId })`. It also carries a static `pause: { signal, resumeStep: "decide" }` annotation — the build-time graph edge that must match the directive.
- **`decide`** reads the callback payload **directly as its `run` input** — that's the signal payload the external world delivered. Everything else (config, job params, ids) is read back from `ctx.shared`, which survives the pause.
- `pauseUntilSignal` is a **runtime primitive, not a metered capability**. The only billed call is the model summary in `decide` (`ctx.sapiom.models.run`, the live x402 path). Note: `ctx.sapiom.llm` does **not** exist — use `models.run`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- A step that pauses declares `next: []` and a `pause: { signal, resumeStep }` annotation; the `resumeStep` is its forward edge.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation, including the static `pause` annotation.
- **run_local** — runs your **real** step code against **stub capabilities**. With no `CALLBACK_REGISTER_URL` configured (or `DRY_RUN` set), the `dryRun` guard skips the live external POST and the local runner auto-resumes the pause, so you get the full `kickoff → paused → decide → branch` trace offline for free.
- **deploy**, then **run** — ship it, then perform a real run that pauses.

### Firing the resume signal in dev

A real `run` pauses at `kickoff`. To resume it without a real webhook, fire the signal via the MCP `signal_workflow` / `workflow_signal` tool — the manual stand-in for the callback:

```json
{
  "signal": "webhook.callback",
  "correlationId": "<executionId of the paused run>",
  "payload": { "status": "succeeded", "result": { "note": "job done" } }
}
```

The `payload` arrives as `decide`'s input.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities + the `dryRun` guard), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Capture non-deterministic values (timestamps, ids) once and pass them forward via the `goto(...)` input or `ctx.shared` rather than recomputing them. The `correlationId` is `ctx.executionId` (stable across the pause), so the resume signal always lands on the right run.
