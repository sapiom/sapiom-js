# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Newsletter
Autopilot** — authored against `@sapiom/agent`. It has six steps: `research`
(calls `web.search`) → `dedupe` (calls `web.scrape`, then dedupes/ranks
in-process) → `write` (calls `models.run`, the live LLM) → `selfEdit` (calls
`models.run` again to grade the draft, looping back to `write` at most once)
→ `illustrate` (calls `contentGeneration.images`) → `deliver` (emails the
issue to a list, or to a demo inbox with none set). Inside a step's `run`,
Sapiom capabilities are pre-auth'd on `ctx.sapiom` (e.g.
`ctx.sapiom.search.webSearch(...)`, `ctx.sapiom.models.run(...)`,
`ctx.sapiom.contentGeneration.images.create(...)`,
`ctx.sapiom.email.messages.send(...)`).

This template absorbs two siblings that used to ship separately:
`news-roundup` contributed the dedupe/rank-and-narrow discipline (folded into
`dedupe`); `scheduled-research-brief` contributed the honest zero-setup
delivery (folded into `deliver`'s demo-inbox fallback). Both are retired in
favor of this one — fork this template instead of either.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **Keep the edges slim.** The scraped article bodies are the only large data here; `dedupe` caps them to `MAX_SOURCES` entries and they travel only across the `write ⇄ selfEdit` revision loop as edge payload — they never enter `ctx.shared`. Large shared state stalls transitions on the cloud engine (the `backlog-nudge` boundary lesson).
- **The self-edit loop is bounded, not optional.** `selfEdit` always terminates within `MAX_SELF_EDIT_ITERATIONS` attempts — pass or not — same shape as `eval-gate`'s `judge` → `decide`. Never remove the attempt cap or the fallback publish-anyway path.
- **Gate real side effects behind `dryRun`.** `deliver` sends email only on a live run with `dryRun` off; otherwise it returns the finished issue as a preview. Keep new external side effects behind the same guard.
- **The zero-setup send is real, not skipped.** With no `subscribers` configured, `deliver` emails the issue to this agent's own self-provisioned demo inbox (`resolveSenderInbox`) rather than reporting `delivered: false`. Never swap that for a plausible-looking fake address.
- **Keep best-effort steps best-effort.** `illustrate` never throws — a missing image is a warning, not a failed run. This is also what lets `run_local` (which stubs image generation) trace the full graph.
- **Config is not a secret.** The subscriber list is ordinary run input (`subscribers`, declared as a `settings[]` entry in `template.json`), not a vault key.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so `web.search` / `web.scrape` / `models.run` / `images.create` return built-in defaults and the agent runs end-to-end offline for free. Pass `dryRun: true` so `deliver` skips the (stubbed) send and returns the preview. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed search + scrape + two-model write/self-edit + header image, and deliver the issue. Attach the `schedule` as a cron trigger to run it weekly.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Delivery channel: email vs. memory

This template delivers by **email** (`ctx.sapiom.email`) to a list, or to its
own demo inbox with none set. To fan the issue into Sapiom **memory**
instead — a searchable long-term archive of past issues — swap the send in
`deliver` for an append, e.g.:

```ts
await ctx.sapiom.memory.append({
  content: body,
  scope: "newsletter-autopilot",
  metadata: { niche, subject, sources },
});
```

Keep the same `dryRun` guard around it. Memory needs no recipients. Recall past issues later with `ctx.sapiom.memory.recall({ query, scope })`.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Capture non-deterministic values (timestamps, ids) once and pass them forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
