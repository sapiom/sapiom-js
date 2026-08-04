# Multi-Party Approval Chain (Saga)

A durable, sequential multi-party sign-off flow. An ordered chain of approvers
(e.g. legal → finance → the CEO) must each approve a subject — a contract, a
budget, a policy change — **in order**, with reminders and timeout escalation
between gates, and **compensation** if anyone rejects.

Each gate is a durable `pauseUntilSignal`: the run suspends at **$0** until the
current party decides, then advances to the next gate. Nothing irreversible
happens until every party has signed off.

## What it does

```
start → present ─(pause: approval.decision, $0 while idle)─▶ decide
          ▲                                                    │
          │ approve & more gates                              │
          └────────────────────────────────────────────────── ┤
        remind ─(pause: approval.decision)────────────────────┤ reminder tick (budget left)
          ▲                                                     │
          └───────────────────────── reminder tick ─────────────┤
                                                                 │
     reject │              approve & last gate │        timeout / no-response │
            ▼                                  ▼                              ▼
       compensate                          finalize                       escalate
       (terminal)                          (terminal)                      (terminal)
```

1. **start** — resolve the `subject`, the ordered `approvers`, and the
   escalation / ledger / reminder settings; initialise the chain state. Empty
   chain → `escalate`.
2. **present** — record the gate as `pending` and email the current approver
   (`ctx.sapiom.email`), then `pauseUntilSignal({ signal: "approval.decision", resumeStep: "decide" })`.
   The run suspends here at $0.
3. **decide** (resume target) — its **input is the approval payload**.
   - `{ "decision": "approve" }` → record it and advance to the next gate
     (`present`), or `finalize` on the last gate.
   - `{ "decision": "reject" }` → `compensate`.
   - `{ "decision": "timeout" }` → `escalate` immediately.
   - anything else (no decision, `remind`, or a `run_local` auto-resume) → a
     reminder tick: `remind` while the reminder budget lasts, else `escalate`.
4. **remind** — email a reminder to the current approver, then pause again on the
   same gate (`resumeStep: "decide"`).
5. **finalize** — the single irreversible action, reached **only after every party
   approved**. A `dryRun` guard makes it a no-op offline.
6. **compensate** — saga rollback: notify everyone who already approved that the
   chain was cancelled.
7. **escalate** — a gate went silent (or timed out): notify the escalation channel.

The canonical chain state lives in `ctx.shared` (it survives every pause). When a
`ledgerHandle` is configured, each transition is also appended to a durable
Postgres table (`approval_chain_ledger`) via `ctx.sapiom.database` — a best-effort
external audit copy that never blocks the chain.

## Reminders, escalation, and why the gates wait forever

Each gate pauses **indefinitely** at $0 — it carries no pause `timeoutMs`. That is
deliberate: the engine has a paused-run reaper that _terminates_ a lapsed pause
with a `PauseTimeoutError` (it does not resume the step), so a deadline here would
silently fail any approval slower than the deadline and never run the graceful
`escalate` step. A legitimately slow approver must not lose the run.

Reminders and escalation are therefore driven entirely by the `approval.decision`
signal, not by an engine deadline:

- the run-detail **one-click Approve/Reject** (a human acting whenever they get to it),
- a **cron** you wire to fire `{ "decision": "remind" }` on a cadence, escalating
  to `{ "decision": "timeout" }` when you want to give up, or
- a `run_local` **auto-resume** (offline), which fires an empty payload and so
  walks `remind` → … → `escalate` for free.

`maxReminders` (default 2) bounds how many reminder ticks a gate takes before it
escalates. (The mirror template `wait-for-webhook` _wants_ the terminal timeout and
so opts into `timeoutMs`; this chain wants a reminder, so it must not — don't add a
gate `timeoutMs` back without switching to that terminal model.)

Input:

```json
{
  "subject": "Master Services Agreement v3",
  "approvers": [
    { "id": "legal", "name": "Legal", "email": "legal@example.com" },
    { "id": "finance", "name": "Finance", "email": "finance@example.com" }
  ],
  "escalateTo": "ops@example.com",
  "maxReminders": 2,
  "ledgerHandle": "approvals-ledger"
}
```

`escalateTo` and `ledgerHandle` fall back to `config.ESCALATION_EMAIL` /
`config.LEDGER_HANDLE` when omitted. Omit `ledgerHandle` to keep the audit trail
in `ctx.shared` only (no Postgres touched).

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the steps inherit
   that authority to send notifications and provision the ledger database.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (capabilities
   stubbed, pauses auto-resumed, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real run that pauses
   at each gate).

Offline, the default `run_local` trace walks `present → reminder(s) → escalate` —
with no `ledgerHandle` no live Postgres is touched, so it's free. Keep
`maxReminders` small so it terminates quickly.

## Resuming a paused run in dev

A real `run` pauses at each gate. Instead of a real approver, fire the signals
yourself with **Resume run** in Run Inspector, or via local MCP `sapiom_dev_agents_signal` (hosted MCP: `sapiom_workflow_signal`). The
`correlationId` is the paused run's `executionId`, and each `payload` becomes the
resumed `decide` step's input.

**Approve** the current gate (advances to the next, or finalises on the last):

```json
{
  "executionId": "<executionId>",
  "name": "approval.decision",
  "correlationId": "<executionId of the paused run>",
  "payload": { "decision": "approve" }
}
```

Fire one `approve` per approver to reach `finalize`. To walk the other branches:

- `{ "decision": "reject" }` → `compensate` (notifies prior approvers).
- `{ "decision": "remind" }` → a reminder tick (re-notifies, re-pauses).
- `{ "decision": "timeout" }` → `escalate`.

## Persisting the audit ledger

Pass a `ledgerHandle` (or `config.LEDGER_HANDLE`) and run **deployed** with
`dryRun: false`. Each transition is appended to the `approval_chain_ledger` table
of a Postgres provisioned on demand (`ctx.sapiom.database`), keyed on
`(execution_id, seq)` so step retries are idempotent. `run_local` stubs the
database, so verify the rows on the deployed path.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
