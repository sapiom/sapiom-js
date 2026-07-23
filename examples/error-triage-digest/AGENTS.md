# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Error / Log Triage Digest** — authored against `@sapiom/agent`. It has four steps: `collect` (pause/pull the batch) → `triage` (calls `models.run`, the live LLM) → `dedupe` (calls `database`) → `digest` (emails the result). Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (e.g. `ctx.sapiom.models.run(...)`, `ctx.sapiom.database.get(...)`, `ctx.sapiom.email.messages.send(...)`, `ctx.sapiom.vault.get(...)`).

It combines two durability primitives with real fan-in: it can **pause at $0** for a pushed webhook batch (`pauseUntilSignal`) or run on a **cron** with a pulled batch, and it keeps a **Postgres dedup store** so a daily digest surfaces new issues instead of re-alerting on known ones.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **The pause is a static edge.** `collect` declares `pause: { signal: "errors.pushed", resumeStep: "triage" }` and returns `pauseUntilSignal({ signal, resumeStep, correlationId })` — the two must match. The resumed `triage` step's _input_ is the signal payload (`{ errors: [...] }`); everything else survives the suspend in `ctx.shared`.
- **Keep the edges slim.** The raw error bodies are bounded (truncated, capped count) before the model sees them and don't linger in `ctx.shared`. Large shared state stalls transitions on the cloud engine.
- **Gate real side effects behind `dryRun`.** `dedupe` skips the database and `digest` skips the send when `dryRun` is set (or no recipient resolves), returning the computed digest as a preview. Keep new external side effects behind the same guard.
- **Read secrets/config at runtime, never persist them.** The recipient is read from the vault (`ctx.sapiom.vault.get("error-triage-digest", "RECIPIENT")`) inside `digest`, not carried through `ctx.shared`.
- **Fingerprint stability is the contract.** The model is asked to derive a fingerprint from an error's invariant parts and strip volatile bits, so the same recurring error keys the same row across runs. If dedup looks wrong, that prompt is the first place to look.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so `models.run` / `database` / `email` return built-in defaults and the agent runs end-to-end offline for free. Pass `dryRun: true` so `dedupe` skips the (stubbed) DB and `digest` skips the (stubbed) send and returns the preview. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed LLM triage that writes to the dedup store and delivers the digest. Attach the `schedule` as a cron trigger, or push a batch with the `errors.pushed` signal.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Delivery channel: email vs. memory

This template delivers by **email** (`ctx.sapiom.email`). To deliver into Sapiom **memory** instead — a searchable long-term store rather than an inbox — swap the send in `digest` for an append, e.g.:

```ts
await ctx.sapiom.memory.append({
  content: body,
  scope: deliverTo ?? "error-triage-digest",
  metadata: { newCount, recurringCount },
});
```

Keep the same `dryRun` guard around it. Memory needs no recipient, so you can drop the vault lookup — or keep it to override the scope.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). The dedup timestamp is captured once at the DB boundary via Postgres `now()` rather than a per-row JS clock, so retries don't skew `last_seen`.
