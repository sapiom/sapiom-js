# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Slack Notifier**
— authored against `@sapiom/agent`. It has three worker paths from two steps:
`validate` (checks input, resolves config) → `post` (reads a credential from the
Vault and calls Slack via `fetch`), plus the terminal steps `posted` / `failed`
/ `rejected`. Inside a step's `run`, Sapiom capabilities are pre-auth'd on
`ctx.sapiom` (here, `ctx.sapiom.vault.get("slack", ...)`).

The lesson is the "bring your own API" shape: **store a secret in the Vault,
read it at runtime, call an external API with it.** Slack has no Sapiom
capability namespace, so we call it directly with `fetch`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. `ctx.sapiom.vault.get(ref, key)` returns `string | null`.
- **Never bake a secret into code.** Read it at runtime from the Vault. The
  `post` step already does this; the `VAULT_REF` / key constants at the top of
  `index.ts` are the only things to change when repointing to another API.
- The `dryRun` / no-credential guard keeps the graph runnable offline. Keep it:
  `run_local` stubs the Vault (returns null), and `dryRun` skips the network, so
  the full graph traces for free before a token is set.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to
run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full
  local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**, so
  the Vault read returns null and the `no-credential` guard skips the post; the
  agent runs end to end offline for free and returns a per-step trace.
- **deploy**, then set your Slack token in the Vault (see `README.md`), then
  **run** — posts to Slack for real.

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
