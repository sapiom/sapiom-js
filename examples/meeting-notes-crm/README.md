# Meeting Notes → CRM Updater

Take a meeting transcript, extract the contact, the CRM fields to update, and the
action items with an LLM, write them to a database, and email a summary. The
transcript arrives directly or by a durable webhook pause.

## What it does

```
intake  ──▶  extract  ──▶  upsert  ──▶  summary  (terminal)
(pause/take)  (models.run)  (database)   (email)
```

1. **intake** — takes the transcript. It reads one directly as `transcript`, or —
   with `webhook: true` and no transcript yet — **pauses at $0** via
   `pauseUntilSignal` until your note-taker pushes one as the `transcript.ready`
   signal. No polling loop, no billed idle.
2. **extract** — hands the transcript to an LLM (`ctx.sapiom.models.run` — the
   live x402-served model) to pull structured data: the **contact** the call was
   with, the **CRM fields** to change (deal stage, next step), and the **action
   items**, each with an owner and due date when the call named them.
3. **upsert** — writes to a Postgres CRM store the template owns
   (`ctx.sapiom.database`). It updates the contact's row (keyed by email, falling
   back to company) with `coalesce`, so a partial call never wipes a field, and
   records each action item under a **stable id** so a re-run logs it once.
4. **summary** — writes a markdown recap (fields updated, action items new vs.
   already tracked) and emails it. A `dryRun` computes the recap but skips the DB
   writes and the real send; the recipient is read from the Sapiom vault at
   runtime, never persisted.

Input: `{ "transcript": "Call with Dana Ruiz, VP Eng at Northwind. ...", "deliverTo": "you@example.com", "meetingDate": "2026-07-22" }`.

- `transcript` (or the `transcript.ready` webhook) supplies the notes.
- `deliverTo` sets the recipient; omit it to use the vault-configured default.
- `meetingDate` (ISO) stamps the contact's last-meeting time.
- `dryRun: true` returns the recap as a preview without writing or sending.

### Two ways in

- **Direct / scheduled** — pass the notes as `transcript` (e.g. a nightly job over
  yesterday's calls).
- **Webhook push** — run with `webhook: true`; the run suspends until your
  note-taker pushes a transcript with the `transcript.ready` signal, then resumes
  and processes it.

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
   stubbed; pass `dryRun: true` so the DB and delivery are skipped, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`
   (a real, billed LLM extraction that writes to the CRM store and emails the
   summary).

4. To push transcripts in, run with `webhook: true` and fire the
   `transcript.ready` signal with the `workflow_signal` MCP tool, passing
   `{ "transcript": "..." }`.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
