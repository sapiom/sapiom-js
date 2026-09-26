# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Fan Out and
Combine** — authored against `@sapiom/agent`. It splits a goal into parts, runs each
part as its own child agent run in parallel, then merges the results:
`plan` → `fanOut` → `fanIn` (once per child) → `reduce` → `done`, with a `solve`
leaf and a `planned` (dry-run) off-ramp. Inside a step's `run`, Sapiom capabilities
are pre-auth'd on `ctx.sapiom` (here: `ctx.sapiom.agents.launch`, `ctx.sapiom.llm.run`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined
  by `@sapiom/tools` — read the types / use autocomplete rather than guessing.
- **One agent, two roles, chosen by `mode`.** The default (`coordinate`) fans out;
  each child is launched with `mode: "leaf"`, and the leaf path (`solve`) does one
  unit of work and terminates. A leaf NEVER fans out — that is what bounds the
  recursion to a single level. Don't let `solve` launch children.
- **It composes itself.** `fanOut` defaults `childDefinition` to `ctx.agentName`, the
  run's own slug, so a deployed copy dispatches leaf runs of itself with no other
  deployment. Point `childDefinition` at another slug to fan that out instead.
- **Launch, then pause; never wait inside a step.** `fanOut` launches every child
  with `ctx.sapiom.agents.launch` (items deduped, one `idempotencyKey` per item, so
  a retried step resolves to the same children) and pauses on the first. The engine
  resumes `fanIn` with that child's result; `fanIn` records it and pauses on the
  next pending child until none remain. One pause names one child, so this loop is
  the fan-in. Don't go back to `Promise.all` over `agents.run`: each waiting call
  polls the agents API every 3 s, and many coordinators waiting at once fail with
  429s. The bookkeeping is the pure `recordChildResult`, tested in `index.test.mjs`.
- **A pause timeout fails the run.** `CHILD_WAIT_TIMEOUT_MS` is a safety net far
  above a leaf's runtime, not a deadline.
- **Never fail.** Every child launch is wrapped: a throw or a `failed` result
  becomes a `{ ok: false }` row, and `reduce` runs over the survivors. If
  nothing came back with content, `reduce` says so instead of inventing an answer,
  and its model call is itself wrapped to fall back to the raw parts. Keep those
  guards if you edit the steps.
- **Runs with nothing.** `plan` defaults the goal and the items, so `{}` in produces
  a real fan-out. `dryRun: true` returns the plan via `planned` without dispatching.

## Test it

- `npm test` runs the fan-in bookkeeping tests.
- `run_local` with `{ "dryRun": true }` traces the fan-out plan offline for free (no
  capability calls). A non-dry local run dispatches STUBBED children that complete
  with empty output, so `reduce` reports that no analysis came back — expected
  offline, and honest.
- Deployed, a run with `{}` fans a sample goal into three parallel child runs of
  itself and returns one combined answer.

## Platform rules (served, not restated here)

The rules that are true of Sapiom regardless of this project's SDK version — which capability
calls an LLM, database lifetime, trigger kinds, App Link webhooks, composing deployed agents —
are served live at <https://api.sapiom.ai/v1/agents/authoring-rules> and summarized in the
`sapiom-agent-authoring` skill's platform chapters. This file was written against release 1.1 of
that text; `sapiom_dev_agents_check` warns when the served copy differs.

<!-- sapiom-authoring-rules release=1.1 digest=8ed17f08af11 -->
