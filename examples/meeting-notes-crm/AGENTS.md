# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Meeting Notes → CRM Updater** — authored against `@sapiom/agent`. It has four steps: `intake` (pause/take the transcript) → `extract` (calls `models.run`, the live LLM) → `upsert` (calls `database`) → `summary` (emails the result). Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (e.g. `ctx.sapiom.models.run(...)`, `ctx.sapiom.database.get(...)`, `ctx.sapiom.email.messages.send(...)`, `ctx.sapiom.vault.get(...)`).

It combines a durability primitive with a real store: it can **pause at $0** for a pushed transcript (`pauseUntilSignal`) or take one directly, and it keeps a **Postgres CRM store** of contacts and action items so a re-processed transcript updates the record instead of duplicating it.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **The pause is a static edge.** `intake` declares `pause: { signal: "transcript.ready", resumeStep: "extract" }` and returns `pauseUntilSignal({ signal, resumeStep, correlationId })` — the two must match. The resumed `extract` step's _input_ is the signal payload (`{ transcript: "..." }`); everything else survives the suspend in `ctx.shared`.
- **Keep the edges slim.** The transcript is bounded (truncated to `MAX_TRANSCRIPT_CHARS`) before the model sees it, and only the small extracted object crosses the later edges — the raw transcript doesn't linger in `ctx.shared`. Large shared state stalls transitions on the cloud engine.
- **Gate real side effects behind `dryRun`.** `upsert` skips the database and `summary` skips the send when `dryRun` is set (or no recipient resolves), returning the computed recap as a preview. Keep new external side effects behind the same guard.
- **Read secrets/config at runtime, never persist them.** The recipient is read from the vault (`ctx.sapiom.vault.get("meeting-notes-crm", "RECIPIENT")`) inside `summary`, not carried through `ctx.shared`.
- **Key stability is the contract.** The contact key (email → company → name) and each action item's `stableId` must resolve the same across runs, so a re-processed transcript updates the same contact row and records each item once. If dedup looks wrong, `resolveContactKey` / `normalizeText` are the first place to look.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so `models.run` / `database` / `email` return built-in defaults and the agent runs end-to-end offline for free. Pass `dryRun: true` so `upsert` skips the (stubbed) DB and `summary` skips the (stubbed) send and returns the recap. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed LLM extraction that writes to the CRM store and emails the summary. Push a transcript with the `transcript.ready` signal.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Delivery channel: email vs. memory

This template delivers by **email** (`ctx.sapiom.email`). To deliver into Sapiom **memory** instead — a searchable long-term store rather than an inbox — swap the send in `summary` for an append, e.g.:

```ts
await ctx.sapiom.memory.append({
  content: body,
  scope: deliverTo ?? "meeting-notes-crm",
  metadata: { newCount, existingCount },
});
```

Keep the same `dryRun` guard around it. Memory needs no recipient, so you can drop the vault lookup — or keep it to override the scope.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Row timestamps are captured once at the DB boundary via Postgres `now()` rather than a per-row JS clock, so retries don't skew `updated_at` / `last_meeting_at`.
