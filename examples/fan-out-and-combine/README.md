# Fan Out and Combine

Split a goal into parts, run each part as its own child agent run in parallel, then
merge the results into one answer — fan out, fan in, reduce. The canonical "an agent
composes other agents" template, built on `ctx.sapiom.agents.launch` and a pause on
each child.

## What it does

```
                 ┌─ agents.launch (leaf) ─┐
plan ─▶ fanOut ──┼─ agents.launch (leaf) ─┼─(pause)▶ fanIn ⟲ ─▶ reduce ─▶ done   (coordinate)
                 └─ agents.launch (leaf) ─┘                     (llm.run) (terminal)

plan ─▶ solve ─▶ (terminal)                                    (leaf)
        (llm.run)

plan ─▶ planned ─▶ (terminal)                                  (dryRun)
```

One agent, two roles chosen by `mode`:

1. **plan** — resolves the `goal`, the `items` to fan out, and the
   `childDefinition` (defaults to this agent's own slug, `ctx.agentName`). A leaf
   goes straight to `solve`; a dry run goes to `planned`; otherwise it fans out.
2. **fanOut** — launches one child run per item via `ctx.sapiom.agents.launch`
   (one `idempotencyKey` per item) and pauses until the first child answers. A
   launch that throws becomes a failed row instead of sinking the batch.
3. **fanIn** — resumed by the engine with one child's result. Records it (a
   `failed` child becomes a failed row) and pauses on the next pending child, or
   moves on to `reduce` when none remain. Nothing polls while the children run,
   so many coordinators can wait at once without hitting the API's rate limit.
4. **reduce** — combines the children's analyses into one answer
   (`ctx.sapiom.llm.run`). If nothing came back with content, it says so rather
   than inventing a result.
5. **solve** _(leaf)_ — the unit of work: one `ctx.sapiom.llm.run` analysis of a
   single item toward the goal, then terminate. A leaf never fans out — that bounds
   the recursion to one level.
6. **done** / **planned** — terminal. `done` returns the combined answer plus a
   per-child status; `planned` returns the fan-out plan with nothing dispatched.

Input:
`{ "goal": "…", "items": ["…", "…"], "childDefinition": "some-slug", "dryRun": false }`

- `goal` and `items` are the two knobs — what to accomplish, and the parts to fan
  it across (one child run per item).
- `childDefinition` (optional) is the slug of the agent to run per item; it
  defaults to this agent, so the template composes itself with no other deployment.
- `dryRun: true` returns the resolved fan-out plan without dispatching any children.

## Run it

- **Use this template** in the app — Sapiom builds and deploys it, and a run with
  no input fans a sample goal into three parallel child runs of itself.
- **Locally:** `run_local` with `{ "dryRun": true }` traces the fan-out plan for
  free (the child capability is stubbed offline). `npm test` runs the fan-in
  bookkeeping tests.
