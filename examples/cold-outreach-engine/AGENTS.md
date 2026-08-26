# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Cold Outreach Personalization Engine** — authored against `@sapiom/agent`. It has eight steps: `enrich` (contact lookup) → `scrape` (`web.scrape`) → `personalize` (`llm.run`) → `verify` (email verification) → `launch` (`database`) → `send` (`email`) ⇄ `advance` → `done`. Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (e.g. `ctx.sapiom.search.emailSearch.findEmail(...)`, `ctx.sapiom.search.scrape(...)`, `ctx.sapiom.llm.run(...)`, `ctx.sapiom.search.emailSearch.verifyEmail(...)`, `ctx.sapiom.database.get(...)`, `ctx.sapiom.email.messages.send(...)`).

`send` and `advance` form a drip **loop**: `send` delivers a touch and then pauses until the drip interval elapses or a prospect replies; `advance` wakes, removes anyone who replied, and either loops back to `send` for the next touch or ends the run. The loop is bounded by the number of touches in the sequence.

**Zero-setup (`{}`, no `leads`)** takes a different path through the same graph, not a different graph: `enrich` works the built-in `DEMO_LEADS` (three fabricated companies/contacts) instead of calling email search — it has nobody real to find at a company that doesn't exist, so `enrich` and `verify` simulate the capability response deterministically for these. `scrape` likewise uses each demo lead's canned `context` blurb instead of fetching a `.example` domain that won't resolve. `personalize` (the live model call), `launch` (persisting the campaign), and `send` (an actual email) all still run for real — `send` just redirects every demo touch to this agent's own Sapiom-hosted inbox (`resolveSenderInbox`) instead of the fabricated address, and stops right after that first touch rather than entering the multi-touch drip or the durable reply-wait, neither of which has a real prospect to wait on. `ctx.shared.get("demoRun")` is the flag every step branches on.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.
- **The pause is a static edge.** `send` declares `pause: { signal: "reply.received", resumeStep: "advance" }` and returns `pauseUntilSignal({ signal, resumeStep, correlationId, timeoutMs })` — the two must match. The resumed `advance` step's _input_ is the signal payload (`{ email }`); everything else survives the suspend in `ctx.shared`.
- **The timeout IS the drip cadence.** `pauseUntilSignal`'s `timeoutMs` (from `dripIntervalDays`) is what wakes the run to send the next touch when nobody replies. A reply signal wakes it sooner and drops that prospect.
- **Keep the edges slim.** The scraped company bodies are bounded (truncated) before the model sees them and are handed only to `personalize` keyed by domain — they never enter `ctx.shared`. Large shared state stalls transitions on the cloud engine.
- **Gate real side effects behind `dryRun`.** `launch` returns the plan and terminates when `dryRun` is set — no send, no DB, no drip. Keep new external side effects behind the same guard.
- **Degrade, don't abort.** Enrichment, scraping, verification, and sends are all wrapped per-item: a failure skips that lead/domain/contact and logs a warning rather than throwing the whole run. Verification failures keep the contact flagged `unverified` rather than silently dropping a lead.
- **The opener is structured output, and never invented.** `personalize` sets `output: { name: OPENERS_TOOL, schema: OPENERS_SCHEMA }` on the `llm.run` spec and reads the openers back with `ctx.sapiom.llm.structuredOf` — there is no JSON to parse. A reply carrying no openers throws; a prospect the model wrote no opener for is marked undeliverable rather than emailed one. The generic opener this replaced ("I've been following what your team is building") is exactly the flattery the prompt forbids, and it went to a real address on a run reported as `succeeded` (SAP-2892). Don't reintroduce a per-contact fallback: these lines get emailed.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so email search / `llm.run` / `database` / `email` return built-in defaults and the agent runs offline for free. Pass `dryRun: true` so `launch` returns the plan and skips the (stubbed) send, DB, and drip. Returns a per-step trace.
- **deploy**, then **run** — ship it, then perform a real, billed run that enriches, personalizes, verifies, and sends. Fire the `reply.received` signal to end the drip early, or attach the `schedule` as a cron trigger.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Every timestamp — contact creation, touch sends, reply time — is captured at the DB boundary via Postgres `now()`, not a per-row JS clock, so retries don't skew the campaign log.
