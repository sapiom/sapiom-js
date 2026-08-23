---
"@sapiom/tools": minor
---

`models.run`: `ModelRunOutcome` gains an optional `warnings` array surfacing routing/honesty warnings when the platform reports them on the run result — e.g. a supplied `model` value the platform didn't recognize, which (with the SAP-2765 platform-side change) routes via the platform default instead of being silently dropped. Treat absent as no warnings.
