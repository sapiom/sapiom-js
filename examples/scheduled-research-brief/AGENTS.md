# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Scheduled Research Brief** — authored against `@sapiom/agent`. It has four steps: `search` (calls `web.search`) → `scrape` (calls `web.scrape`) → `curate` (calls `models.run`, the live LLM) → `deliver` (emails the brief). Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (e.g. `ctx.sapiom.search.webSearch(...)`, `ctx.sapiom.models.run(...)`, `ctx.sapiom.email.messages.send(...)`).

It is the scheduled, LLM-curated, delivered evolution of `web-research-digest`. That template formats a digest in-process (no LLM, no delivery); this one adds real LLM curation (`models.run`) and email delivery on a cron cadence.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **Keep the edges slim.** The scraped article bodies are the only large data here; they stay bounded (truncated, capped count) and die at the `curate` boundary — they never enter `ctx.shared`. Large shared state stalls transitions on the cloud engine (the `backlog-nudge` boundary lesson).
- **Gate real side effects behind `dryRun`.** `deliver` sends email only on a live run with `dryRun` off and a recipient resolved; otherwise it returns the computed brief as a preview. Keep new external side effects behind the same guard.
- **Read secrets/config at runtime, never persist them.** The recipient is read from the vault (`ctx.sapiom.vault.get("scheduled-research-brief", "RECIPIENT")`) inside `deliver`, not carried through `ctx.shared`. The same seam is where a bring-your-own delivery token would be read.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so `web.search` / `web.scrape` / `models.run` return built-in defaults and the agent runs end-to-end offline for free. Pass `dryRun: true` so `deliver` skips the (stubbed) send and returns the preview. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed search + scrape + LLM curation, and deliver the brief. Attach the `schedule` as a cron trigger to run it on a cadence.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Delivery channel: email vs. memory

This template delivers by **email** (`ctx.sapiom.email`). To deliver into Sapiom **memory** instead — a searchable long-term store rather than an inbox — swap the send in `deliver` for an append, e.g.:

```ts
await ctx.sapiom.memory.append({
  content: brief,
  scope: deliverTo ?? "research-brief", // reuse deliverTo as the memory scope
  metadata: { topic, sources },
});
```

Keep the same `dryRun` guard around it. Memory needs no recipient, so you can drop the vault lookup — or keep it to override the scope. Recall past briefs later with `ctx.sapiom.memory.recall({ query, scope })`.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Capture non-deterministic values (timestamps, ids) once and pass them forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
