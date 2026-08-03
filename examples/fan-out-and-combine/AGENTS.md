# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Fan Out and
Combine** — authored against `@sapiom/agent`. It splits a goal into parts, runs each
part as its own child agent run in parallel, then merges the results:
`plan` → `fanOut` → `reduce` → `done`, with a `solve` leaf and a `planned` (dry-run)
off-ramp. Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom`
(here: `ctx.sapiom.agents.run`, `ctx.sapiom.models.run`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined
  by `@sapiom/tools` — read the types / use autocomplete rather than guessing.
- **One agent, two roles, chosen by `mode`.** The default (`coordinate`) fans out;
  each child is launched with `mode: "leaf"`, and the leaf path (`solve`) does one
  unit of work and terminates. A leaf NEVER fans out — that is what bounds the
  recursion to a single level. Don't let `solve` call `agents.run`.
- **It composes itself.** `fanOut` defaults `childDefinition` to `ctx.agentName`, the
  run's own slug, so a deployed copy dispatches leaf runs of itself with no other
  deployment. Point `childDefinition` at another slug to fan that out instead.
- **`agents.run` blocks; that's the join.** `fanOut` uses `Promise.all` over
  `ctx.sapiom.agents.run` — each call waits for its child to reach a terminal state,
  so the whole step resolves when every child is done. (`pauseUntilSignal` only
  suspends on ONE handle, so it can't express a fan-in over many children.)
- **Never fail.** Every child dispatch is wrapped: a throw or a non-`completed`
  status becomes a `{ ok: false }` row, and `reduce` runs over the survivors. If
  nothing came back with content, `reduce` says so instead of inventing an answer,
  and its model call is itself wrapped to fall back to the raw parts. Keep those
  guards if you edit the steps.
- **Runs with nothing.** `plan` defaults the goal and the items, so `{}` in produces
  a real fan-out. `dryRun: true` returns the plan via `planned` without dispatching.

## Test it

- `run_local` with `{ "dryRun": true }` traces the fan-out plan offline for free (no
  capability calls). A non-dry local run dispatches STUBBED children that complete
  with empty output, so `reduce` reports that no analysis came back — expected
  offline, and honest.
- Deployed, a run with `{}` fans a sample goal into three parallel child runs of
  itself and returns one combined answer.
