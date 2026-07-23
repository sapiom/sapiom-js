# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Eval Gate** —
authored against `@sapiom/agent`. It's an LLM-judge quality gate: `judge` scores
an output against **your** rubric with one `ctx.sapiom.models.run` call and parses
a `[0,1]` score; `gate` branches `publish` vs `revise` on `score >= threshold`;
the terminal steps return `{ decision, score, threshold, rationale }`. The only
genuinely new code is `judge.ts` (`buildJudgePrompt` + `parseScore`).

## The judge is a metered `models.run` call

- The judge LLM call goes through `ctx.sapiom.models.run({ prompt, model?, maxTokens })`
  — the real, deploy-injected, **metered** LLM path (x402 at
  `tools.sapiom.ai/models/v1`). It returns `{ output: string | null, … }`.
- **`ctx.sapiom.llm` does not exist** — use `models.run`. Do not read `LLM_GATEWAY_*`
  env vars or POST `/v1/messages` directly; those are not injected on deploy.
- The judge rides the same step→gateway path as everything else, so the engine's
  routing / capacity / load-balancing sit in front of it for free — no
  evals-specific execution path.

## The rubric is yours; the harness is ours

- We ship one generic default judge prompt (`buildJudgePrompt`) and a tolerant
  score parser (`parseScore`). Override the **rubric** (the `rubric` input), not
  this scaffolding.
- `parseScore` prefers a JSON `{score, rationale}`, falls back to the first bare
  number, clamps to `[0,1]`, and tolerates a 0–100 answer. It **throws** when no
  number can be parsed — a malformed reply is transient, so the engine retries.
- Building your own eval = editing three inputs: the **rubric**, the **threshold**
  (default `0.7`), and the judge **model**. See `README.md`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- The input contract is enforced by a zod schema (`inputSchema`) on the entry
  `judge` step, with an `examples` block the gallery renders.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.

## Validating

When you've made a coherent change and want to validate it — the same point you'd
run tests in any project — reach for the local suite.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` method you
  used exists.
- **check** — typecheck + bundle + manifest + step-graph validation.
- **run_local** — runs your **real** step code against **stub capabilities**.
  The _default_ `models.run` stub returns a non-numeric placeholder, and
  `parseScore` throws on a reply with no number (by design — a malformed judge
  reply is transient), so you **must supply a stub score** to trace the graph.
  Pass a stub whose `models.run` response carries a numeric `output`, and flip it
  to verify **both** branches:

  ```jsonc
  // high score → publish
  { "version": 1, "steps": { "judge": {
    "models.run": { "output": "{\"score\":0.9,\"rationale\":\"meets the rubric\"}" }
  } } }

  // low score → revise
  { "version": 1, "steps": { "judge": {
    "models.run": { "output": "{\"score\":0.4,\"rationale\":\"misses the rubric\"}" }
  } } }
  ```

  The stub value is returned verbatim as the `models.run` result; `parseScore`
  reads its `output`. A bare number (`"output": "0.9"`) works too.

- **deploy**, then **run** — ship it, then perform a real, **billed** judge call
  that meters `models.run` and returns the decision from a real score.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities), not the other way around — never weaken or drop real
> logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Composition — self-grading with the eval-gate as a child

A parent workflow can grade its own output by launching the deployed eval-gate as
a **child** and branching on the returned decision. The parent POSTs to
`https://api.sapiom.ai/v1/workflows/executions` with
`{ definitionId, input, idempotencyKey }` using `process.env.SAPIOM_API_KEY` (a
raw HTTP call — **not** a capability namespace, and **not**
`ctx.sapiom.agents.launch`, which 404s in prod), then `pauseUntilSignal(...)` at
$0 until the child's decision arrives as a signal, and branches ship/regenerate.
Guard the outbound POST behind a `dryRun` flag so `run_local` stays offline and
free. Full parent sketch + the dev resume signal are in `README.md`.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
