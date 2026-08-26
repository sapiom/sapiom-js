# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — the
**Self-Editing Writer** — authored against `@sapiom/agent`. It drafts a piece
against **your** brief, grades the draft against **your** rubric with an LLM
judge, and revises in a bounded loop until it clears the bar or the attempt
cap is hit: `parse` → `draft` → `judge` → `decide` → (loop back to `draft`, or
terminate at `publish`). The only genuinely new code is `draft.ts`
(`buildDraftPrompt`) and `judge.ts` (`buildJudgePrompt` + `parseScore`).

## Two chained `llm.run` calls

- `draft` calls `ctx.sapiom.llm.run({ request, model? })` to write
  (or revise) the piece. `judge` calls it again to score that draft against
  the rubric. The judge's input is the draft step's output — a model reading
  another model's output — so this is chained judgment: a bad draft can
  produce a bad critique, and the loop is what corrects for that, not a single
  perfect call.
- **Use the typed `ctx.sapiom.llm.run` client.** Do not read
  `LLM_GATEWAY_*` env vars or POST `/v1/messages` directly; those are not
  injected on deploy.
- Both calls ride the same step→gateway path as everything else, so the
  engine's routing / capacity / load-balancing sit in front of them for free.

## The brief and rubric are yours; the harness is ours

- We ship one default judge prompt (`buildJudgePrompt`) and one default draft
  prompt (`buildDraftPrompt`), plus a tolerant score parser (`parseScore`).
  Override the **brief** and **rubric** (the run inputs), not this scaffolding.
- `parseScore` prefers a JSON `{score, rationale}`, falls back to the first
  bare number, clamps to `[0,1]`, and tolerates a 0–100 answer. It **throws**
  when no number can be parsed — a malformed reply is transient, so the engine
  retries. `draft` throws on an empty reply for the same reason: there's
  nothing real to grade otherwise.
- Building your own eval-writer = editing three inputs: the **brief**, the
  **rubric**, and the **threshold** (default `0.8`). See `README.md`.

## The bounded revise-loop

- `decide` reads the judge's score and the run's `iteration` counter from
  `ctx.shared`. `score >= threshold` **or** `iteration >= maxIterations`
  (default `2`) sends the run to `publish`; otherwise it stashes the rejected
  draft + critique in `ctx.shared` for the next `draft` attempt, increments
  `iteration`, and loops back.
- `maxIterations` is the hard bound — `decide` never loops past it, so the
  graph always terminates. There is no unbounded revise path.
- `publish` is honest either way: it always returns the final draft, but
  `passed` says whether it actually cleared the rubric or the run merely ran
  out of attempts. There is no separate "reject" terminal — a self-editing
  writer that fails still has to hand back something, so it hands back its
  best attempt and says so in `note`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- The input contract is enforced by a zod schema (`inputSchema`) on the entry
  `parse` step, with an `examples` block the gallery renders.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` method you
  used exists.
- **check** — typecheck + bundle + manifest + step-graph validation.
- **run_local** — runs your **real** step code against **stub capabilities**.
  The _default_ `llm.run` stub returns a non-numeric placeholder, and both
  `draft` (empty-reply check) and `parseScore` (unparseable-score check) throw
  on that by design, so you **must supply stub replies** to trace the graph:
  a stub draft string for the `draft` step's call, and a stub `{score,
rationale}` JSON for the `judge` step's call. Flip the judge's stub score to
  verify both branches:

  ```jsonc
  // high score → decide → publish (passed: true)
  { "version": 1, "steps": {
    "draft": { "llm.run": { "content": [{ "type": "text", "text": "A short noir opening line." }] } },
    "judge": { "llm.run": { "content": [{ "type": "text", "text": "{\"score\":0.9,\"rationale\":\"meets the rubric\"}" }] } }
  } }

  // low score, maxIterations: 1 → decide → publish (passed: false)
  { "version": 1, "steps": {
    "draft": { "llm.run": { "content": [{ "type": "text", "text": "A short noir opening line." }] } },
    "judge": { "llm.run": { "content": [{ "type": "text", "text": "{\"score\":0.4,\"rationale\":\"misses the rubric\"}" }] } }
  } }
  ```

  With the default `maxIterations: 2` and a low judge score, `run_local` walks
  the loop back to `draft` a second time before reaching `publish` — trace it
  by supplying the same stub pair again for the second pass.

- **deploy**, then **run** — ship it, then perform a real, **billed**
  draft+judge cycle that meters two `llm.run` calls per attempt.

> Write each step the way it should run in production. `run_local` adapts to
> your code (stub capabilities), not the other way around — never weaken or
> drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids, the draft text
itself) once and pass them forward via the `goto(...)` input or `ctx.shared`
rather than recomputing them.
