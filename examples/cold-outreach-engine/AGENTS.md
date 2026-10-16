# Working in this agent

This project defines exactly one Sapiom agent in `index.ts`: **Opt-in Lead Follow-up**, authored against `@sapiom/agent`. It has six steps: `intake` → `scrape` (`web.scrape`) → `personalize` (`llm.run`) → `verify` (email verification) → `enroll` (`database`) → `send` (`email`). A run that brings no new contacts goes straight from `intake` to `send`. Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (e.g. `ctx.sapiom.search.scrape(...)`, `ctx.sapiom.llm.run(...)`, `ctx.sapiom.search.emailSearch.verifyEmail(...)`, `ctx.sapiom.database.get(...)`, `ctx.sapiom.email.messages.send(...)`, `ctx.sapiom.email.threads.get(...)`).

**Only opt-in contacts.** Every contact must carry an `optInSource` (where they asked to hear from you); `intake` rejects any contact without one and reports it under `rejected`. Do not add a step that finds or emails people who never contacted the sender (email search, list buying, scraped addresses): unsolicited bulk email breaks Sapiom's terms of use and the email provider's.

**Follow-ups come from a schedule, not a pause.** Each run makes one pass over the stored roster and ends. The user attaches a cron trigger that runs the agent with `{ "campaign": "<name>" }`. Do not reintroduce `pauseUntilSignal({ timeoutMs })` as the wait between touches: a pause timeout fails the run on Sapiom and does not resume it.

**Zero-setup (`{}`, no `contacts` and no `campaign`)** takes the same graph with `DEMO_CONTACTS` (three fabricated opt-ins). `scrape` uses each one's canned blurb and `verify` treats it as deliverable. `personalize` (the live model call), `enroll` (a real database write) and `send` (a real email) all run for real. `send` delivers the demo touch to this agent's own Sapiom-hosted inbox (`resolveSenderInbox`), never to the fabricated address. Demo rows are stored with status `demo`, so no scheduled pass follows them up. `ctx.shared.get("demoRun")` is the flag every step branches on.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools`. Read the types or use autocomplete rather than guessing; a wrong capability or method name fails typecheck.
- **The roster is the state between runs.** `enroll` and `send` throw if the campaign database is unavailable, because without the roster no follow-up can go out. `ctx.shared` lasts only one run.
- **Campaign config is stored.** `send` saves `sequence`, `dripIntervalDays`, `senderName` and `inboxId` to `outreach_campaigns`. A run that passes only `campaign` uses the saved values; a run that passes any of them overwrites them.
- **Reply detection reads the thread.** Before a follow-up, `send` calls `email.threads.get` on the contact's thread. A message from any address other than the sending inbox ends the sequence for that contact. Follow-ups go out with `email.messages.reply` (with an explicit `to`) so the contact's answer lands in that thread.
- **Surface every send failure.** A failed send or thread read is pushed to `sendFailures` in the output with its HTTP status and error code. If every send on a pass fails, the step returns `fail(...)` with the output attached, so the run ends `failed`. Do not swallow a send error into a log line. A 403 `recipient_not_allowed` means a free `sapiom.email` inbox tried to reach outside the organization; the output's `note` tells the user to pass `inboxId`.
- **Keep the edges slim.** Scraped page bodies are truncated before the model sees them and are handed only to `personalize`, keyed by domain. They never enter `ctx.shared`.
- **Gate real side effects behind `dryRun`.** `enroll` returns the plan and terminates when `dryRun` is set, so there is no database write and no send. Keep new external side effects behind the same guard.
- **The opener is structured output, and never invented.** `personalize` sets `output: { name: OPENERS_TOOL, schema }` on the `llm.run` spec and reads the openers back with `ctx.sapiom.llm.structuredOf`; there is no JSON to parse. A reply carrying no usable openers throws. A contact the model wrote no opener for is marked undeliverable rather than emailed a canned line (SAP-2892).

## Validating

When you've made a coherent change and want to validate it (the same point you'd run tests in any project), reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`**: types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **`npm test`**: unit tests for contact intake, reply-address parsing and opener parsing.
- **check**: typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local**: runs your **real** step code against **stub capabilities**, so `llm.run`, `database` and `email` return built-in defaults and the agent runs offline for free. Pass `dryRun: true` so `enroll` returns the plan and skips the database and the send. Returns a per-step trace.
- **deploy**, then **run**: ship it, then do a real, billed run that enrolls contacts and sends the first touch. Attach a `schedule_cron` trigger with `{ "campaign": "<name>" }` for the follow-ups.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around. Never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` / `schedule` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw).

- **Timestamps:** every timestamp (enrollment, touch sends, reply time) and the "is this touch due" check use Postgres `now()`, not a JS clock.
- **No double sends on retry:** each successful send updates the contact's `touches_sent` and `last_sent_at` immediately, so a retried pass does not send the same touch twice.
- **No double sends across runs:** a session advisory lock per campaign stops two overlapping passes from both sending.

## Platform rules (served, not restated here)

The rules that are true of Sapiom regardless of this project's SDK version are served live at <https://api.sapiom.ai/v1/agents/authoring-rules> and summarized in the `sapiom-agent-authoring` skill's platform chapters. They cover:

- which capability calls an LLM;
- database lifetime;
- trigger kinds;
- App Link webhooks;
- composing deployed agents.
