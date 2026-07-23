# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Proposal / Quote
Generator** — authored against `@sapiom/agent`. From a free-text requirement it
drafts a proposal with an LLM, renders it to a PDF in a sandbox, persists the file,
pauses for a human to sign off, and only then emails the proposal to the client.
Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom`
(`ctx.sapiom.models.run`, `ctx.sapiom.sandboxes`, `ctx.sapiom.fileStorage`,
`ctx.sapiom.email`).

## The spine

- **`draft`** calls `ctx.sapiom.models.run` for a structured proposal, then totals
  the line items **in code** — the money is never trusted from the model.
- **`render`** creates a sandbox, `writeFile`s `proposal.json` + a `pdf-lib` layout
  script (`RENDER_SCRIPT`), `exec`s the render, reads the PDF back as base64, and
  PUTs the bytes to the presigned URL from `ctx.sapiom.fileStorage.upload`. The
  sandbox is destroyed in a `finally`. Under `run_local` the sandbox exec is
  stubbed (empty output) — the step detects the empty render and skips the real
  byte PUT while still walking the upload shape, so the offline trace stays whole.
- **`review`** emails the approver, then returns
  `pauseUntilSignal({ signal: "proposal.decision", resumeStep: "onDecision", correlationId: ctx.executionId })`.
  It carries a static `pause: { signal, resumeStep: "onDecision" }` annotation —
  the build-time graph edge that must match the directive.
- **`onDecision`** reads the approval payload **directly as its `run` input**. Safe
  default: only `{ decision: "approve" }` proceeds to `send`; anything else
  (including a `run_local` resume with no payload) routes to `rejected` — nothing
  reaches the client without a deliberate yes.
- **`send`** holds the one outward action (the client email), reached only after
  approval. A `dryRun` guard makes it a no-op.
- `pauseUntilSignal` is a **runtime primitive, not a metered capability** — don't
  list it in `capabilities`. The billed calls are `ctx.sapiom.models.run` (the
  live x402 path — note `ctx.sapiom.llm` does **not** exist), the sandbox render,
  the file upload, and `ctx.sapiom.email`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- A step that pauses declares `next: []` (its forward edge is the pause
  `resumeStep`) and a `pause: { signal, resumeStep }` annotation.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined
  by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A
  wrong capability or method name fails typecheck.
- The PDF layout is intentionally dependency-light (`pdf-lib`, standard Helvetica,
  no browser). It lives in `RENDER_SCRIPT`; edit that string to change the document.

## Validating

When you've made a coherent change and want to validate it — the same point you'd
run tests in any project — reach for the local suite. You don't need to run it
after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation, including the
  static `pause` annotation.
- **run_local** — runs your **real** step code against **stub capabilities** and
  auto-resumes the pause. With no payload injected, the approval resume takes the
  safe reject branch, so you get a full offline trace for free.
- **deploy**, then **run** — ship it, then perform a real run that pauses.

### Firing the resume signal in dev

A real `run` pauses once, at `review`. To resume without a real approver, fire the
signal via the MCP `signal_workflow` / `workflow_signal` tool — the manual
stand-in:

```json
{ "signal": "proposal.decision", "correlationId": "<executionId>", "payload": { "decision": "approve" } }
```

Send `{ "decision": "reject" }` to walk the reject path. The `payload` arrives as
`onDecision`'s input.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities + the `dryRun` guard), not the other way around — never
> weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values once and pass them forward via the
`goto(...)` input or `ctx.shared` rather than recomputing them. The quote number
is derived from `ctx.executionId` (stable across retries and the pause), and
`correlationId` is `ctx.executionId`, so a resume signal always lands on the right
run.
