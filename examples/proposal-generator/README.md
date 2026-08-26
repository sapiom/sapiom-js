# Proposal / Quote Generator

Turn a free-text requirement into a client-ready PDF quote — drafted by an LLM,
rendered in a sandbox, then **paused for human sign-off** before it's emailed to
the client. Nothing reaches the client until a person approves it. Run it with
nothing set at all and it still drafts and renders a real PDF from a built-in
sample brief — it just stops at the sign-off gate instead of pausing, since
nothing would ever fire an unconfigured approval signal.

## What it does

```
draft ─▶ render ─▶ review ─┬─(pause: proposal.decision, $0 while idle)─▶ onDecision
(llm.run) (sandbox +    │ (approver set)                                 │
             fileStorage)  │                            approve ◀─────────┼─▶ reject
                           │                              ▼               ▼
                           │                            send          rejected
                           │                         (terminal)       (terminal)
                           └─(no approver)─▶ pending
                                             (terminal)
```

1. **draft** — an LLM (`ctx.sapiom.llm.run`) turns the `request` into a
   structured proposal: title, summary, scope, and priced line items. Then
   deterministic code totals the line items (the money is never trusted from the
   model). Reversible. Omit `request` and it drafts against a built-in sample
   brief, so a zero-input run still produces a real, priced quote.
2. **render** — create a sandbox (`ctx.sapiom.sandboxes.create`), lay the proposal
   out as a PDF with a small self-contained Node script (`pdf-lib`, pure JS), and
   persist the bytes to file storage (`ctx.sapiom.fileStorage.upload`). The
   sandbox is torn down before the step returns. Stores the `fileId` + a download
   link.
3. **review** — with an `approver` assigned, email them a summary and the PDF
   link (`ctx.sapiom.email`), then `pauseUntilSignal({ signal: "proposal.decision", resumeStep: "onDecision" })`.
   The run suspends here at $0. With **no approver assigned** — the zero-setup
   default — this step does not pause (nothing would ever fire the signal): it
   takes the `pending` branch instead.
4. **onDecision** (resume target) — its **input is the approval payload**. Only an
   explicit `{ "decision": "approve" }` proceeds to `send`; anything else takes
   the safe `rejected` branch — nothing goes to the client.
5. **send** — the one outward action: email the finished proposal to the client.
   A `dryRun` guard makes it a no-op so a deployed run can be traced safely.
6. **pending** — terminal: no approver was assigned, so the run stops holding
   the drafted proposal, its real PDF download link, and the signal that would
   continue it (`outcome: "pending-approval"`). Nothing was sent, and nothing
   was approved or rejected.
7. **rejected** — terminal: nothing was sent; the draft PDF is still in file
   storage for a human to pick up.

Input:

```json
{
  "request": "We need a marketing website: 5 pages, a blog, a contact form, and basic SEO. Launch in 6 weeks.",
  "client": {
    "name": "Dana Lee",
    "company": "Northwind Coffee",
    "email": "dana@northwind.example.com"
  },
  "from": { "company": "Acme Studio" },
  "currency": "USD",
  "taxRate": 0.08,
  "approver": "owner@acme.example.com"
}
```

The `approver` and client `email` fall back to `config.APPROVER_EMAIL` /
`config.CLIENT_EMAIL` when omitted. Pass `dryRun: true` to run everything but skip
the client email.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the steps inherit
   that authority to call the model, run the sandbox, store the file, and send
   the emails.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (capabilities stubbed, pause auto-resumed, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`. With an `approver` set,
   that run pauses at `review`; with none set (e.g. `{}`), it terminates at
   `pending` instead — drafted, rendered, and waiting on a sign-off nobody's
   been assigned yet.

## Resuming a paused run in dev

A real `run` pauses once, at `review` — but only when an `approver` is set;
otherwise `review` terminates at `pending` instead of pausing (see above).
Instead of a real approver, fire the signal yourself via the MCP
`signal_workflow` / `workflow_signal` tool. The `correlationId` is the paused
run's `executionId`, and the `payload` becomes the resumed step's input.

**Approve** (resumes `onDecision` → `send`, emailing the client):

```json
{
  "signal": "proposal.decision",
  "correlationId": "<executionId of the paused run>",
  "payload": { "decision": "approve" }
}
```

Send `{ "decision": "reject" }` instead to see the `rejected` path — nothing goes
to the client and the draft PDF stays on file.

## Files

- `index.ts` — the agent (edit this). The PDF layout lives in `RENDER_SCRIPT` at
  the bottom; change it to make the document your own.
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
