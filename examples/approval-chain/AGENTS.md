# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Multi-Party
Approval Chain (Saga)** — authored against `@sapiom/agent`. It runs an ordered
list of approvers through sequential, durable sign-off gates
(`present` ⇄ `remind` → `decide`), advancing one gate at a time, and terminates in
`finalize` (all approved), `compensate` (someone rejected), or `escalate` (a gate
went silent). Inside a step's `run`, Sapiom capabilities are pre-auth'd on
`ctx.sapiom` (here, `ctx.sapiom.email` and `ctx.sapiom.database`).

## The sign-off spine

- **`present`** records the current gate as `pending`, emails the approver, then
  returns `pauseUntilSignal({ signal: "approval.decision", resumeStep: "decide", correlationId: ctx.executionId, timeoutMs })`.
  It carries a static `pause: { signal, resumeStep: "decide" }` annotation — the
  build-time graph edge that must match the directive.
- **`decide`** reads the approval payload **directly as its `run` input**. Safe
  default: only an explicit `{ decision: "approve" }` advances; `reject`
  compensates; `timeout` escalates; anything else (including a `run_local` resume
  with no payload, or the engine firing the pause `timeoutMs`) is a **reminder
  tick**. The gate index, reminder count, recorded approvals, and audit trail all
  live in `ctx.shared` and survive every pause.
- **`remind`** re-notifies the current approver and re-pauses on the same gate
  (`resumeStep: "decide"`), so `present → decide → remind → decide → …` is a
  legal cycle bounded by `maxReminders`.
- **`finalize`** holds the single irreversible action, reached only after EVERY
  gate approved. A `dryRun` guard makes it a no-op offline.
- **`compensate`** is the saga's rollback: notify everyone who already approved
  that the chain was cancelled. Nothing irreversible ran before a rejection, so
  the compensation is a set of notifications, not an undo of committed work.
- `pauseUntilSignal` is a **runtime primitive, not a metered capability** — don't
  list it in `capabilities`. The billed calls are `ctx.sapiom.email` and, when a
  `ledgerHandle` is set, the `ctx.sapiom.database` the ledger lives in.

## Chain state & the ledger

The canonical state is `ctx.shared`. The `database` capability is an **optional,
best-effort** durable copy: `recordTransition` appends every transition to
`ctx.shared.trail` and, when a `ledgerHandle` is configured and it's not a
`dryRun`, also to a Postgres `approval_chain_ledger` table (via a `pg` client on
the provisioned connection string). A missing handle, a `dryRun`, or any DB error
degrades to shared + logs and never fails the chain. Rows are keyed on
`(execution_id, seq)` with `ON CONFLICT DO NOTHING`, so a step retry is idempotent.

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
  the static `pause` annotations (the cycle through `remind` is legal).
- **run_local** — runs your **real** step code against **stub capabilities** and
  auto-resumes each pause with no payload, so the default trace walks
  `present → reminder(s) → escalate` to a terminal for free. With no
  `ledgerHandle`, no live Postgres is touched.
- **deploy**, then **run** — ship it, then perform a real run that pauses at each
  gate.

### Firing the resume signals in dev

A real `run` pauses at every gate. To resume without a real approver, fire the
signals via the MCP `signal_workflow` / `workflow_signal` tool — the manual
stand-in. The `correlationId` is the paused run's `executionId`, and each
`payload` arrives as `decide`'s input.

```json
{
  "signal": "approval.decision",
  "correlationId": "<executionId>",
  "payload": { "decision": "approve" }
}
```

Fire one `approve` per approver to reach `finalize`. Send `{ "decision": "reject" }`
to walk `compensate`, or `{ "decision": "remind" }` / `{ "decision": "timeout" }`
to exercise the reminder / escalation branches.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities + the `dryRun` guard), not the other way around — never
> weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them —
the ledger uses DB-side `now()` for timestamps to stay deterministic across
retries. The `correlationId` is `ctx.executionId` (stable across every gate), so a
resume signal always lands on the right run.
