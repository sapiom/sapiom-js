# Fan Out and Combine

Split a goal into parts, run each part as its own child workflow in parallel, then
merge the results into one answer — fan out, join, reduce. The canonical "a workflow
composes other workflows" template, built on `ctx.sapiom.agents.run`.

## What it does

```
                 ┌─ agents.run (leaf) ─┐
plan ─▶ fanOut ──┼─ agents.run (leaf) ─┼─▶ reduce ─▶ done      (coordinate)
                 └─ agents.run (leaf) ─┘   (models.run) (terminal)

plan ─▶ solve ─▶ (terminal)                                    (leaf)
        (models.run)

plan ─▶ planned ─▶ (terminal)                                  (dryRun)
```

One agent, two roles chosen by `mode`:

1. **plan** — resolves the `goal`, the `items` to fan out, and the
   `childDefinition` (defaults to this agent's own slug, `ctx.agentName`). A leaf
   goes straight to `solve`; a dry run goes to `planned`; otherwise it fans out.
2. **fanOut** — launches one child run per item via `ctx.sapiom.agents.run` and
   waits for all of them (`Promise.all`). Each dispatch is wrapped, so a child that
   throws or does not complete becomes a failed row instead of sinking the batch.
3. **reduce** — combines the children's analyses into one answer
   (`ctx.sapiom.models.run`). If nothing came back with content, it says so rather
   than inventing a result.
4. **solve** _(leaf)_ — the unit of work: one `ctx.sapiom.models.run` analysis of a
   single item toward the goal, then terminate. A leaf never fans out — that bounds
   the recursion to one level.
5. **done** / **planned** — terminal. `done` returns the combined answer plus a
   per-child status; `planned` returns the fan-out plan with nothing dispatched.

Input:
`{ "goal": "…", "items": ["…", "…"], "childDefinition": "some-slug", "dryRun": false }`

- `goal` and `items` are the two knobs — what to accomplish, and the parts to fan
  it across (one child run per item).
- `childDefinition` (optional) is the slug of the workflow to run per item; it
  defaults to this agent, so the template composes itself with no other deployment.
- `dryRun: true` returns the resolved fan-out plan without dispatching any children.

## Run it

- **Use this template** in the app — Sapiom builds and deploys it, and a run with
  no input fans a sample goal into three parallel child runs of itself.
- **Locally:** `run_local` with `{ "dryRun": true }` traces the fan-out plan for
  free (the child capability is stubbed offline).
