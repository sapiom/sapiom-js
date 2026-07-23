# Human-in-the-Loop Approval

The "ask before you commit/spend" pattern: do some reversible work, then **pause
for a human approval signal** before committing an irreversible or expensive
action — and once approved, act via a **ranked sequential-fallback loop** (try
candidates in order until one accepts, escalating if the list runs out).

Nothing irreversible or billed happens until a human approves **and** a candidate
accepts.

## What it does

```
parse → rank → notifyApprover ─(pause: approval.decision, $0 while idle)─▶ onDecision
                                                                             │
                       reject ◀─────────────────────────────────────────────┼─▶ approve
                         │                                                    ▼
                       revert (terminal)                  offer ─(pause: candidate.confirm)─▶ resolve
                                                            ▲                                   │
                                    decline/timeout & more ─┘      accept │ exhausted │         │
                                                                          ▼           ▼
                                                                      commit       escalate
                                                                     (terminal)    (terminal)
```

1. **parse** — parse the free-text `request` into structured intent with an LLM
   (`ctx.sapiom.models.run`). Reversible.
2. **rank** — rank the `candidates` by fit (not just cost) with the LLM;
   every candidate is returned exactly once. Reversible.
3. **notifyApprover** — email the approver the ranked recommendation
   (`ctx.sapiom.email`), then `pauseUntilSignal({ signal: "approval.decision", resumeStep: "onDecision" })`.
   The run suspends here at $0.
4. **onDecision** (resume target) — its **input is the approval payload**. Only
   an explicit `{ "decision": "approve" }` proceeds; anything else takes the safe
   `revert` branch (nothing committed).
5. **offer** — provisional, non-committing offer to the current top candidate,
   then `pauseUntilSignal({ signal: "candidate.confirm", resumeStep: "resolve" })`.
6. **resolve** (resume target) — its **input is the confirm payload**. `accept`
   → `commit`; `decline`/`timeout` → advance to the next candidate (loop back to
   `offer`) or `escalate` once the list is exhausted.
7. **commit** — the single irreversible/expensive action, reached only after
   approval **and** an accept. A `dryRun` guard makes it a no-op offline.
8. **revert / escalate** — terminal branches: revert to a safe state, or escalate
   to a human channel.

Input:

```json
{
  "request": "Find someone to repaint the lobby by Friday, quality over price.",
  "candidates": [
    { "id": "a", "name": "Acme Painting", "email": "acme@example.com" },
    { "id": "b", "name": "Budget Coats", "email": "budget@example.com" }
  ],
  "approver": "approver@example.com",
  "escalateTo": "ops@example.com"
}
```

The `approver` and `escalateTo` addresses fall back to `config.APPROVER_EMAIL` /
`config.ESCALATION_EMAIL` when omitted.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the steps inherit
   that authority to call the model and send notifications.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (capabilities stubbed, pauses auto-resumed, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real run that pauses).

## Resuming a paused run in dev

A real `run` pauses twice. Instead of a real approver / candidate, fire the
signals yourself via the MCP `signal_workflow` / `workflow_signal` tool. The
`correlationId` is the paused run's `executionId`, and each `payload` becomes the
resumed step's input.

**Approve** (resumes `onDecision`):

```json
{
  "signal": "approval.decision",
  "correlationId": "<executionId of the paused run>",
  "payload": { "decision": "approve" }
}
```

**Accept** the provisional offer (resumes `resolve` → `commit`):

```json
{
  "signal": "candidate.confirm",
  "correlationId": "<executionId of the paused run>",
  "payload": { "decision": "accept" }
}
```

Exercise the fallback by sending `{ "decision": "decline" }` (or `"timeout"`) on
`candidate.confirm` instead — the run advances to the next candidate and offers
again; decline every candidate to see it `escalate`. Send
`{ "decision": "reject" }` on `approval.decision` to see the `revert` path.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
