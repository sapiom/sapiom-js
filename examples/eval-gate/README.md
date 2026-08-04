# Self-Editing Writer

A **draft-and-critique loop**. Give it a brief and a rubric; it drafts, grades
its own draft against the rubric with an LLM judge, and revises — bounded —
until the draft clears the bar, then publishes. It is a **chained** pattern:
the judge's input is the draft's output, so the second model call reads what
the first one wrote.

## What it does

```
parse ─▶ draft ─▶ judge ─▶ decide ─┬─▶ draft   (score < threshold, attempts remain)
              (loop back)           └─▶ publish (score >= threshold, or attempts exhausted)
```

1. **parse** (entry) — validates the run input against a zod schema, defaults
   an omitted `brief`/`rubric` to a built-in sample, and seeds the loop state
   (`iteration = 1`).
2. **draft** — writes (or, on a later attempt, revises) the piece from the
   brief via `ctx.sapiom.models.run`. On a revision it also gets the rejected
   draft and the judge's critique, so it can fix the specific problem instead
   of starting over blind.
3. **judge** — scores the draft against **your** rubric with a second
   `ctx.sapiom.models.run` call, and parses a `[0,1]` score plus a one-line
   critique from the reply.
4. **decide** — pure branch, no model call: `score >= threshold` **or**
   `iteration >= maxIterations` sends the run to `publish`. Otherwise it hands
   the rejected draft + critique back to `draft`, advances the attempt
   counter, and loops. `maxIterations` (default `2`) bounds the loop — it
   always reaches `publish`.
5. **publish** (terminal) — returns `{ draft, passed, score, threshold,
   iterations, rationale }`. `passed` says whether the draft actually cleared
   the rubric or the run simply ran out of attempts; either way the final
   draft comes back, never a silent failure.

Input contract: `{ brief, rubric, threshold=0.8, maxIterations=2, model?, judgeModel? }`.

- `brief` — what to write. Fed to the draft step's prompt.
- `rubric` — **your** pass/fail criteria. The judge scores every draft against
  this.
- `threshold` — the pass bar in `[0,1]` (default `0.8`).
- `maxIterations` — the attempt cap (1 initial draft + revisions, default
  `2`). The run publishes by this attempt regardless of score.
- `model` / `judgeModel` — optional model aliases for the draft and judge
  calls respectively.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; `draft` and
   `judge` both inherit that authority to call the model.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (both `models.run`
   calls are stubbed, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real, **billed**
   draft+judge cycle, possibly more than once per run).

### Tracing the loop offline (run_local)

`run_local` resolves `ctx.sapiom.models.run` from a stub, per step. The
_default_ stub returns a non-numeric placeholder; `draft` throws on an empty
reply and `judge`'s `parseScore` throws on a reply with no number (both by
design), so supply stub replies for **both** calls to trace the graph:

```jsonc
// high score → decide → publish (passed: true), one attempt
{ "version": 1, "steps": {
  "draft": { "models.run": { "output": "A short noir opening line." } },
  "judge": { "models.run": { "output": "{\"score\":0.9,\"rationale\":\"meets the rubric\"}" } }
} }

// low score, maxIterations: 1 → decide → publish (passed: false)
{ "version": 1, "steps": {
  "draft": { "models.run": { "output": "A short noir opening line." } },
  "judge": { "models.run": { "output": "{\"score\":0.4,\"rationale\":\"misses the rubric\"}" } }
} }
```

With the default `maxIterations: 2` and a low judge score, the run loops back
to `draft` once before `publish` — supply the same stub pair again to trace
that second pass.

Run `npm run typecheck` to confirm it compiles (and that every `ctx.sapiom.*`
method you used exists).

## Build your own eval-writer

The brief and rubric are yours; everything else is scaffolding. To adapt this
into a real writer, change three things:

- **The brief** — what you want written. Pass it as the `brief` input.
- **The rubric** — the criteria the judge scores against. Pass it as the
  `rubric` input. This is where all your opinion about "quality" lives; we
  ship none. Example: `"Cites at least one source, no unsupported claims,
  under 200 words."`
- **The threshold** — the pass bar in `[0,1]` (default `0.8`). Raise it to be
  stricter about what reaches `publish` unchanged; lower it to accept more on
  the first attempt.

The draft prompt lives in `draft.ts` (`buildDraftPrompt`); the judge prompt
and score parser live in `judge.ts` (`buildJudgePrompt` + `parseScore`) — the
only genuinely new code. `parseScore` prefers a JSON `{score, rationale}`,
falls back to a bare number, clamps to `[0,1]`, and tolerates a model that
answered on a 0–100 scale.

## Files

- `index.ts` — the agent (edit this).
- `draft.ts` — `buildDraftPrompt`, the writer's prompt (including the revision
  path).
- `judge.ts` — `buildJudgePrompt` + `parseScore`, the judge's prompt and score
  parser.
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `AGENTS.md` — the authoring loop and the loop-bound contract.
