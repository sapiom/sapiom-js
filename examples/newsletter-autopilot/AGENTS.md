# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Newsletter
Autopilot** — authored against `@sapiom/agent`. It has five steps: `search`
(calls `web.search`) → `scrape` (calls `web.scrape`) → `write` (calls
`models.run`, the live LLM) → `header` (calls `contentGeneration.images`) →
`deliver` (emails the issue to a list). Inside a step's `run`, Sapiom
capabilities are pre-auth'd on `ctx.sapiom` (e.g. `ctx.sapiom.search.webSearch(...)`,
`ctx.sapiom.models.run(...)`, `ctx.sapiom.contentGeneration.images.create(...)`,
`ctx.sapiom.email.messages.send(...)`).

It is the published-newsletter evolution of `scheduled-research-brief`. That
template curates a private one-recipient brief with no image; this one has the
LLM write a full issue (subject + body + image prompt), generates a header
image, and emails it to a whole subscriber list on a cadence.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **Keep the edges slim.** The scraped article bodies are the only large data here; they stay bounded (truncated, capped count) and die at the `write` boundary — they never enter `ctx.shared`. Large shared state stalls transitions on the cloud engine (the `backlog-nudge` boundary lesson).
- **Gate real side effects behind `dryRun`.** `deliver` sends email only on a live run with `dryRun` off and subscribers resolved; otherwise it returns the finished issue as a preview. Keep new external side effects behind the same guard.
- **Keep best-effort steps best-effort.** `header` never throws — a missing image is a warning, not a failed run. This is also what lets `run_local` (which stubs image generation) trace the full graph.
- **Read secrets/config at runtime, never persist them.** The subscriber list falls back to the vault (`ctx.sapiom.vault.get("newsletter-autopilot", "SUBSCRIBERS")`) inside `deliver`, not carried through `ctx.shared`.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so `web.search` / `web.scrape` / `models.run` / `images.create` return built-in defaults and the agent runs end-to-end offline for free. Pass `dryRun: true` so `deliver` skips the (stubbed) send and returns the preview. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed search + scrape + LLM write + header image, and deliver the issue. Attach the `schedule` as a cron trigger to run it weekly.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Delivery channel: email vs. memory

This template delivers by **email** (`ctx.sapiom.email`) to a list. To fan the issue into Sapiom **memory** instead — a searchable long-term archive of past issues — swap the per-subscriber send in `deliver` for an append, e.g.:

```ts
await ctx.sapiom.memory.append({
  content: body,
  scope: "newsletter-autopilot",
  metadata: { niche, subject, sources },
});
```

Keep the same `dryRun` guard around it. Memory needs no recipients, so you can drop the vault lookup. Recall past issues later with `ctx.sapiom.memory.recall({ query, scope })`.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Capture non-deterministic values (timestamps, ids) once and pass them forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
