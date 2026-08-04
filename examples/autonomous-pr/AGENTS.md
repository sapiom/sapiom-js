# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` —
**autonomous-pr** — authored against `@sapiom/agent`. It fuses
`dependency-upgrade`'s pattern (coding agent → sandbox re-attach → real
checks → gate the push on green) with `pr-review-bot`'s pattern (a second
model reading a diff to write a structured review), and borrows
`nl-db-query-endpoint`'s provision-or-reuse demo-database pattern (for the
repo itself) plus `research-to-microsite`'s `deployPreview` (for a live look
at the branch) into one end-to-end repo-lifecycle agent. Inside a step's
`run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here:
`ctx.sapiom.repositories.get` / `.create`, `ctx.sapiom.models.coding.launch`,
`ctx.sapiom.sandboxes.attach` / `.create` + `box.exec` / `.writeFile` /
`.deployPreview`, `repo.pushFromSandbox`, and `ctx.sapiom.models.run`).

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
- **`verify` confirms the checkout's real directory before trusting it, and
  every exec bakes that absolute path into the command instead of using
  `exec`'s `cwd` option.** `gitRepository` is *documented* to clone into
  `/workspace/<slug>`, but that's the platform's word, not a guarantee this
  run kept — `verify` probes it (`test -d "<abs>/.git"`), falls back to a
  bounded `find` if it doesn't hold, and routes to a diagnostic `rejected`
  rather than running in the wrong directory. Once confirmed, every command
  targets it explicitly (`git -C "<abs>" ...`, `cd "<abs>" && ...`) rather
  than passing `{ cwd }` to `exec` — `cwd` there is relative to the sandbox's
  `workspaceRoot`, which `sandboxes.attach` (with no coding-run context to
  infer it from) defaults to `/`, so a bare `{ cwd: "/workspace/<slug>" }`
  is not a reliable way to land in the checkout. `push` reuses the same
  confirmed `checkoutCwd` the same way.
- **Green gates the push.** `verify` routes to `rejected` on a failed coding
  run, a failed install, or a non-zero check exit — a push only happens after
  a green check. Don't remove that gate.
- **The demo repo is provisioned once, then reused.** `plan` reads `repoSlug`
  through `resolveResourceHandle` (fallback `""`, key `repoSlug`) — the same
  seam `nl-db-query-endpoint` uses for its demo database. Empty ⇒ open (or,
  the first time, provision) the persistent `DEFAULT_REPO_HANDLE`; a
  caller-named handle that 404s is rejected, never silently reprovisioned.
  `justProvisioned` (set only on the run that actually called
  `repositories.create`) gates the seed in `implement` — every later run
  against the reused repo skips it.
- **The seed only applies on that first, provisioning run.** `SEED_PREAMBLE`
  (and its constants, in `seed.ts`) is prepended to the task only when
  `justProvisioned` is true — a real `repoSlug` a user supplies, or a demo
  repo a prior run already seeded, has its own conventions already; never
  seed over them.
- **The preview server is deterministic, not agent-authored.** `push` writes
  `PREVIEW_SERVER_FILE` (`PREVIEW_SERVER_SOURCE`) into the checkout itself,
  right before the branch is pushed, so `preview` always has something real
  to deploy from that branch regardless of what the coding agent touched. It
  reads `examples/<id>/template.json` files live, at request time, from
  whatever the checkout actually contains.
- **A failed preview never fails the run.** `preview` degrades honestly
  (`previewStatus`, `previewUrl: null`) on any deploy failure or thrown error
  — the branch is already pushed by the time `preview` runs, so a preview
  outage is a lesser story than a failed run over a bonus feature.
- **No `prUrl`.** This platform's git host has no hosted pull-request object
  yet — never fabricate one. The pushed branch (`branch`, `sha`, `cloneUrl`)
  plus its preview (`previewUrl`) is the honest artifact; `summary` sets
  `prUrl: null` on purpose.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to
run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation (including
  the static `pause` annotation). The full local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**.
  Pass `{}`: `repositories.create`/`get`, the coding launch, and
  `deployPreview` are all stubbed and its pause auto-resumes, `sandboxes.exec`
  returns a clean exit, and `push` "succeeds" against a stub repo — so the
  full graph traces offline, free, with no real repo or coding agent.
- **deploy**, then **run** — ship it, then perform a real implement + check +
  push + preview against whichever repo you gave it (or the persistent demo
  repo it opens).

> Write each step the way it should run in production. `run_local` adapts to
> your code (stub capabilities), not the other way around — never weaken or
> drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids, the branch name)
once and pass them forward via `ctx.shared` rather than recomputing them.
