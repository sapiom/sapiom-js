---
"@sapiom/tools": minor
---

`models.run`: the `model` doc-comment now matches actual platform behavior (SAP-2765) — a supplied value is honored as a routing label when known, and never silently dropped: an unknown value routes via the platform default with a warning. `ModelRunOutcome` gains an additive `warnings` array surfacing those routing/honesty warnings (empty for a clean run).
