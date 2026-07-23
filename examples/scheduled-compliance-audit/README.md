# Scheduled Compliance Audit + Attestation

On a cron cadence, collect the current state of your resources, check it against
your policy with an LLM, **pause for a human sign-off**, and — only once a person
approves — archive the signed attestation as a durable file.

Nothing is filed until a human signs off: an attestation is a record that a
person reviewed and approved, so it is never archived automatically.

## What it does

```
collect ──▶ audit ─(pause: attestation.signoff, $0 while idle)─▶ onSignoff
(web.scrape)  (models.run)                                          │
                                             reject ◀────────────────┼─▶ approve
                                               │                      ▼
                                           rejected (terminal)   archive (fileStorage, terminal)
```

1. **collect** — reads each resource's current state with
   `ctx.sapiom.search.scrape` (a config page, a status endpoint, a policy doc),
   degrading per-item on failure. Bodies are truncated and stay bounded — they
   never enter shared state.
2. **audit** — hands the collected state and your `policy` to an LLM
   (`ctx.sapiom.models.run` — the live x402-served model) to produce a structured
   report: an overall verdict plus one check per requirement, each with evidence
   and a remediation for failures.
3. **review** — `pauseUntilSignal({ signal: "attestation.signoff", resumeStep: "onSignoff" })`.
   The run suspends here at $0 until a person signs off.
4. **onSignoff** (resume target) — its **input is the sign-off payload**. Only an
   explicit `{ "decision": "approve" }` proceeds to `archive`; anything else takes
   the safe `rejected` branch, and nothing is archived.
5. **archive** — writes the signed attestation to `ctx.sapiom.fileStorage` and
   returns its `fileId` and a download URL. A `dryRun` guard computes the
   attestation and returns it as a preview without uploading anything.

Input:

```json
{
  "resources": [
    { "id": "api-config", "url": "https://example.com/security.txt", "label": "API security policy" },
    { "id": "status", "url": "https://example.com/status", "label": "Service status" }
  ],
  "policy": "All services must publish a security contact and enforce TLS. Status page must show 99.9% uptime.",
  "schedule": "0 6 * * 1",
  "framework": "SOC 2 CC6",
  "signOffBy": "compliance@example.com"
}
```

- `resources` and `policy` are the two knobs — what to audit, and the rules to
  audit it against.
- `schedule` is the cron cadence; `framework` and `signOffBy` are recorded in the
  attestation.
- `dryRun: true` returns the attestation as a preview without archiving anything.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; each step inherits
   that authority to call its metered capability.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (capabilities
   stubbed, the pause auto-resumed, free — pass `dryRun: true` so `archive` skips
   the upload) → `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` →
   `sapiom_dev_agents_run` (a real, billed collect + policy check that pauses for
   sign-off).

4. To run it on a cadence, attach the `schedule` as a cron trigger on the
   deployed agent.

## Resuming a paused run in dev

A real `run` pauses at `review`. Instead of a real approver, fire the sign-off
signal yourself via the MCP `workflow_signal` / `signal_workflow` tool. The
`correlationId` is the paused run's `executionId`, and the `payload` becomes
`onSignoff`'s input.

**Approve** (resumes `onSignoff` → `archive`):

```json
{
  "signal": "attestation.signoff",
  "correlationId": "<executionId of the paused run>",
  "payload": { "decision": "approve", "signer": "compliance@example.com" }
}
```

Send `{ "decision": "reject" }` instead to see the safe `rejected` path, where
the audit findings come back but nothing is archived.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
