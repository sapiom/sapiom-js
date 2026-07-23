# enrich-canvas (internal Sapiom workflow)

The studio's **Tier-2 canvas enrichment**, run on **Sapiom's own account**.

The harness renders a deterministic **Tier-1** structure diagram for a bound
workflow entirely offline — no LLM, unkillable, free. `enrich-canvas` is the
**opt-in Tier-2 overlay**: given the already-extracted graph plus the workflow's
source bodies, one LLM step (`ctx.sapiom.models.run`) returns short text
annotations — a summary, per-node sublabels/descriptions, edge labels, and a few
notes — as a single JSON object matching the harness's `CanvasEnrichment`
contract (`packages/harness/src/core/canvas-enrichment.ts`).

## Why this exists

It replaces the old headless-`claude` enrichment the studio spawned on the
**user's** Claude Code tokens. Running the enrichment as a Sapiom workflow on our
account means:

- **0 user Claude tokens** — the enrichment is metered by us, not the user.
- **Harness-agnostic** — it works for any session (claude-code, codex, …) because
  it no longer depends on a local headless agent.
- **Silent degrade** — the harness validates the returned object; on any failure
  (or if this workflow isn't deployed/configured) the Tier-1 render simply
  stands. There is no "Visualize failed" state.

## Not a public template

This is an internal workflow — it is intentionally **not** listed in
`examples/registry.json`, so it never appears in the "Use this template" catalog.

## Input / output

- **Input:** `{ graph, stepBodies }` — the extracted `CanvasGraph` and a map of
  the workflow's source files (workflow-relative path → contents). The harness
  supplies both, so this workflow needs no filesystem access.
- **Output:** one JSON object (`terminate(...)`) matching `CanvasEnrichment`.
  Unparseable model output degrades to `{}` (an empty overlay), never a failure.

## Deploy

Deployed to Sapiom's account and wired into the harness by definition id:

```bash
cd examples/enrich-canvas
sapiom agents deploy        # record the returned definitionId
```

Set the recorded id on the harness server via
`SAPIOM_HARNESS_ENRICH_CANVAS_DEFINITION_ID`. When it is unset, the harness skips
enrichment and renders Tier-1 only.
