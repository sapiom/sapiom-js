# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **PR Review Bot** —
authored against `@sapiom/agent`. It builds a concrete workflow on the durable
pause/resume spine: `watch` registers a PR webhook and returns
`pauseUntilSignal(...)`; the run suspends at $0 until a pull request is opened;
`review` (the resume target) receives the PR payload as its input, hands the diff
to a coding agent (`ctx.sapiom.models.coding.run`) that checks the code out and
analyzes it; `assess` turns the findings into a structured review with
`ctx.sapiom.models.run`; then `reportEmail` / `reportSlack` post it.

## The pause/resume spine

- **`watch`** registers `{ executionId, signal, correlationId: ctx.executionId }`
  with the webhook source, then returns
  `pauseUntilSignal({ signal: "pr.opened", resumeStep: "review", correlationId: ctx.executionId })`.
  It also carries a static `pause: { signal, resumeStep: "review" }` annotation —
  the build-time graph edge that must match the directive.
- **`review`** reads the PR webhook payload **directly as its `run` input** —
  that's the signal payload the external world delivered. When it's empty (a
  local run, where nothing recorded a signal), `review` falls back to a built-in
  sample PR from `ctx.shared` so the coding agent always has something to analyze.
  Config, channel, and recipient are read back from `ctx.shared`, which survives
  the pause.
- `pauseUntilSignal` is a **runtime primitive, not a metered capability**. The
  billed calls are the coding run (`models.coding.run`), the model summary
  (`models.run`), the email send (`email`), and — for Slack — the Vault read
  (`vault.get`). Note: `ctx.sapiom.llm` does **not** exist — use `models.run`.

## Read-only review

The coding agent is told **not** to modify or push code — this is a review, not
an edit. We pass `keepSandbox: false` since no later step reads from or pushes
the sandbox. A `run.result?.success` of `false` still costs, so `review` records
whatever the run produced (or its error) and lets `assess` reason over it rather
than throwing.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- A step that pauses declares `next: []` and a `pause: { signal, resumeStep }` annotation; the `resumeStep` is its forward edge.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation, including the static `pause` annotation.
- **run_local** — runs your **real** step code against **stub capabilities**. With no `WEBHOOK_REGISTER_URL` configured (or `DRY_RUN` set), the `dryRun` guard skips the live registration and the report step skips the real send, and the local runner auto-resumes the pause with an empty payload — so `review` uses the sample PR and you get the full `watch → paused → review → assess → report → posted` trace offline for free.
- **deploy**, then **run** — ship it, then perform a real run that pauses.

### Firing the resume signal in dev

A real `run` pauses at `watch`. To resume it without a real webhook, fire the signal via the MCP `signal_workflow` / `workflow_signal` tool — the manual stand-in for the PR webhook:

```json
{
  "signal": "pr.opened",
  "correlationId": "<executionId of the paused run>",
  "payload": { "repo": { "owner": "acme", "name": "api" }, "number": 42, "title": "…", "branch": "feat/x", "baseBranch": "main", "diff": "…" }
}
```

The `payload` arrives as `review`'s input.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities + the `dryRun` guard), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Capture non-deterministic values (timestamps, ids) once and pass them forward via the `goto(...)` input or `ctx.shared` rather than recomputing them. The `correlationId` is `ctx.executionId` (stable across the pause), so the resume signal always lands on the right run.
