# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Human-in-the-Loop
Approval** — authored against `@sapiom/agent`. It demonstrates the "ask before you
commit/spend" pattern: reversible prep (`parse` → `rank` → `notifyApprover`), a
durable pause on a human approval signal, and — once approved — a ranked
sequential-fallback loop (`offer` ⇄ `resolve`) that commits only when a candidate
accepts and escalates when the list is exhausted. Inside a step's `run`, Sapiom
capabilities are pre-auth'd on `ctx.sapiom` (here, `ctx.sapiom.models.run` and
`ctx.sapiom.email`).

## The approval + fallback spine

- **`notifyApprover`** emails the ranked recommendation, then returns
  `pauseUntilSignal({ signal: "approval.decision", resumeStep: "onDecision", correlationId: ctx.executionId })`.
  It carries a static `pause: { signal, resumeStep: "onDecision" }` annotation —
  the build-time graph edge that must match the directive.
- **`onDecision`** reads the approval payload **directly as its `run` input**.
  Safe default: only `{ decision: "approve" }` proceeds; anything else (including
  a `run_local` resume with no payload) routes to `revert` — nothing commits
  without a deliberate human yes.
- **`offer`** makes a *provisional, non-committing* offer to `ranked[index]` and
  pauses on `candidate.confirm`, resuming at `resolve`.
- **`resolve`** reads the confirm payload as its input. `accept` → `commit`;
  `decline`/`timeout`/absent → `index + 1` and loop back to `offer` while
  candidates remain, else `escalate`. The loop edge is `resolve → offer`; the
  loop counter (`index`) lives in `ctx.shared` and survives every pause.
- **`commit`** holds the single irreversible/expensive action, reached only after
  approval AND an accept. A `dryRun` guard makes it a no-op offline.
- `pauseUntilSignal` is a **runtime primitive, not a metered capability** — don't
  list it in `capabilities`. The billed calls are `ctx.sapiom.models.run` (the
  live x402 path — note `ctx.sapiom.llm` does **not** exist) and `ctx.sapiom.email`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- A step that pauses declares `next: []` (its forward edge is the pause
  `resumeStep`) and a `pause: { signal, resumeStep }` annotation.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.

## Validating

When you've made a coherent change and want to validate it — the same point you'd
run tests in any project — reach for the local suite. You don't need to run it
after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation, including
  the static `pause` annotations.
- **run_local** — runs your **real** step code against **stub capabilities** and
  auto-resumes both pauses. With no payload injected, the approval resume takes
  the safe branch and the `dryRun` guard keeps `commit` a no-op, so you get a full
  offline trace for free.
- **deploy**, then **run** — ship it, then perform a real run that pauses.

### Firing the resume signals in dev

A real `run` pauses twice. To resume without a real approver/candidate, fire the
signals via the MCP `signal_workflow` / `workflow_signal` tool — the manual
stand-in. Approve, then accept:

```json
{ "signal": "approval.decision", "correlationId": "<executionId>", "payload": { "decision": "approve" } }
{ "signal": "candidate.confirm", "correlationId": "<executionId>", "payload": { "decision": "accept" } }
```

Send `{ "decision": "decline" }` on `candidate.confirm` to walk the fallback to
the next candidate; `{ "decision": "reject" }` on `approval.decision` to walk the
revert path. Each `payload` arrives as the resumed step's input.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities + the `dryRun` guard), not the other way around — never
> weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
The `correlationId` is `ctx.executionId` (stable across both pauses), so a resume
signal always lands on the right run.
