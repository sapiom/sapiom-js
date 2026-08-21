---
"@sapiom/tools": minor
---

`models.run`: fix the `ModelRunSpec.model` doc-comment — it promised a model override the platform's routing path does not honor as written; the field is a routing label the platform resolves against its configured label set, and an unrecognized value routes via the platform default (SAP-2765). `ModelRunOutcome` gains an optional `warnings` array surfacing routing warnings when the platform reports them on the run result; absent means no warnings.
