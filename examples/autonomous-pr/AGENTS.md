# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` —
**autonomous-pr** — authored against `@sapiom/agent`. It fuses
`dependency-upgrade`'s pattern (coding agent → sandbox re-attach → real
checks → gate the push on green) with `pr-review-bot`'s pattern (a second
model reading a diff to write a structured review) into one end-to-end
"do the work" agent. Inside a step's `run`, Sapiom capabilities are pre-auth'd
on `ctx.sapiom` (here: `ctx.sapiom.repositories.get` / `.create`,
`ctx.sapiom.models.coding.launch`, `ctx.sapiom.sandboxes.attach` + `box.exec`,
`repo.pushFromSandbox`, and `ctx.sapiom.models.run`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.
- **The coding run is async.** `implement` calls `models.coding.launch(...)`
  and returns `pauseUntilSignal(handle, { resumeStep: "verify" })`; the step's
  static `pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "verify" }`
  annotation must match. `verify`'s input is the `CodingResultPayload` —
  re-attach the sandbox from `result.executionEnvironment.id`; live handles
  don't cross the pause.
- **The coding agent never runs git.** Its task only asks it to edit files.
  `verify` reads the plain (unstaged) `git diff --stat`, and `push` creates
  the branch and calls `pushFromSandbox` itself — keeps the branch and the
  push exact and repeatable instead of depending on the agent's own git
  behavior.
- **Green gates the push.** `verify` routes to `rejected` on a failed coding
  run, a failed install, or a non-zero check exit — a push only happens after
  a green check. Don't remove that gate.
- **The seed only applies to the scratch repo.** `SEED_PREAMBLE` (and its
  constants) are prepended to the task **only** when `plan` self-provisioned
  the repo (no `repoSlug` given) — a real `repoSlug` a user supplies has its
  own conventions already; never seed over them.
- **No `prUrl`.** This platform's git host has no hosted pull-request object
  yet — never fabricate one. The pushed branch (`branch`, `sha`, `cloneUrl`)
  is the honest artifact; `summary` sets `prUrl: null` on purpose.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to
run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation (including
  the static `pause` annotation). The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**.
  Pass `{}`: `repositories.create`/`get` and the coding launch are stubbed and
  its pause auto-resumes, `sandboxes.exec` returns a clean exit, and `push`
  "succeeds" against a stub repo — so the full graph traces offline, free,
  with no real repo or coding agent.
- **deploy**, then **run** — ship it, then perform a real implement + check +
  push against whichever repo you gave it (or the scratch one it provisions).

> Write each step the way it should run in production. `run_local` adapts to
> your code (stub capabilities), not the other way around — never weaken or
> drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids, the branch name)
once and pass them forward via `ctx.shared` rather than recomputing them.
