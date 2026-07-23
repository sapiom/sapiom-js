# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Cold Outreach Personalization Engine** — authored against `@sapiom/agent`. It has eight steps: `enrich` (Hunter contact lookup) → `scrape` (`web.scrape`) → `personalize` (`models.run`) → `verify` (Hunter deliverability) → `launch` (`database`) → `send` (`email`) ⇄ `advance` → `done`. Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (e.g. `ctx.sapiom.search.emailSearch.findEmail(...)`, `ctx.sapiom.search.scrape(...)`, `ctx.sapiom.models.run(...)`, `ctx.sapiom.search.emailSearch.verifyEmail(...)`, `ctx.sapiom.database.get(...)`, `ctx.sapiom.email.messages.send(...)`).

`send` and `advance` form a drip **loop**: `send` delivers a touch and then pauses until the drip interval elapses or a prospect replies; `advance` wakes, removes anyone who replied, and either loops back to `send` for the next touch or ends the run. The loop is bounded by the number of touches in the sequence.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **The pause is a static edge.** `send` declares `pause: { signal: "reply.received", resumeStep: "advance" }` and returns `pauseUntilSignal({ signal, resumeStep, correlationId, timeoutMs })` — the two must match. The resumed `advance` step's _input_ is the signal payload (`{ email }`); everything else survives the suspend in `ctx.shared`.
- **The timeout IS the drip cadence.** `pauseUntilSignal`'s `timeoutMs` (from `dripIntervalDays`) is what wakes the run to send the next touch when nobody replies. A reply signal wakes it sooner and drops that prospect.
- **Keep the edges slim.** The scraped company bodies are bounded (truncated) before the model sees them and are handed only to `personalize` keyed by domain — they never enter `ctx.shared`. Large shared state stalls transitions on the cloud engine.
- **Gate real side effects behind `dryRun`.** `launch` returns the plan and terminates when `dryRun` is set — no send, no DB, no drip. Keep new external side effects behind the same guard.
- **Degrade, don't abort.** Enrichment, scraping, verification, and sends are all wrapped per-item: a failure skips that lead/domain/contact and logs a warning rather than throwing the whole run. Verification failures keep the contact flagged `unverified` rather than silently dropping a lead.
- **The opener parse must tolerate junk.** `personalize` parses a JSON array from the model but falls back to a safe generic opener per contact when parsing fails — so the `run_local` stub's non-JSON placeholder still traces end to end.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so Hunter / `models.run` / `database` / `email` return built-in defaults and the agent runs offline for free. Pass `dryRun: true` so `launch` returns the plan and skips the (stubbed) send, DB, and drip. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed run that enriches, personalizes, verifies, and sends. Fire the `reply.received` signal to end the drip early, or attach the `schedule` as a cron trigger.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Every timestamp — contact creation, touch sends, reply time — is captured at the DB boundary via Postgres `now()`, not a per-row JS clock, so retries don't skew the campaign log.
