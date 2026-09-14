# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Slack Notifier**
— authored against `@sapiom/agent`. It has three worker paths from two steps:
`validate` (resolves input and config) → `post` (reads the injected credential and
calls Slack), plus the terminal steps `posted` / `failed` / `rejected`. Bot mode
uses fail-closed `@sapiom/fetch` so its public endpoint is authorized and metered.
Webhook mode uses native fetch because the credential is embedded in the URL and
must never be copied into metering request facts.

The lesson is the "bring your own API" shape: **declare a secret, read it at
runtime from the injected environment, call an external API with it.** Slack has no Sapiom
capability namespace. Bot mode uses the generic metered HTTP wrapper; secret URL
credentials such as incoming webhooks must bypass URL-level request recording.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing.
- **Never bake a secret into code, and never name a store.** The credential is
  declared in `template.json` (`requiredSecrets[]`) and arrives as
  `process.env[BOT_TOKEN_KEY]`. Those key constants at the top of `index.ts` — and
  the matching declaration — are the only things to change when repointing to
  another API.
- The no-credential guard is the whole safety property. Keep it: with no token the
  run composes the message, reports `posted: false, skipped: "no-credential"`, and
  names the missing key in `unmet`. It must never report `posted: true`.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to
run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full
  local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**. With
  no token in your environment the `no-credential` guard skips the post, so the
  agent runs end to end offline for free and returns a per-step trace.
- **deploy**, then supply your Slack token (see `README.md`), then **run** — posts
  to Slack for real.

> Write each step the way it should run in production. `run_local` adapts to
> your code (stub capabilities), not the other way around — never weaken or drop
> real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Slack's `chat.postMessage` has no idempotency key, so a retry after a
successful post but failed ack could double-post — keep the post in its own step
so a retry re-runs only the post, and capture any non-deterministic values
(timestamps, ids) once, passing them forward via `goto(...)` or `ctx.shared`.

## Platform rules (served, not restated here)

The rules that are true of Sapiom regardless of this project's SDK version — which capability
calls an LLM, database lifetime, trigger kinds, App Link webhooks, composing deployed agents —
are served live at <https://api.sapiom.ai/v1/agents/authoring-rules> and summarized in the
`sapiom-agent-authoring` skill's platform chapters. This file was written against release 1.0 of
that text; `sapiom_dev_agents_check` warns when the served copy differs.

<!-- sapiom-authoring-rules release=1.0 digest=1f3e5cd9648f -->
