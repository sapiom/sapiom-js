---
"@sapiom/tools": minor
---

`models.run`: fix the `ModelRunSpec.model` doc-comment — it promised a model override; the field is a routing label the platform resolves against its configured label set, and (with the SAP-2765 platform-side change) an unrecognized value routes via the platform default instead of being silently dropped. `ModelRunOutcome` gains an optional `warnings` array surfacing routing warnings when the platform reports them on the run result; treat absent as no warnings.
