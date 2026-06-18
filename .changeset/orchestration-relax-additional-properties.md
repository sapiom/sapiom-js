---
"@sapiom/orchestration": patch
---

Generated step-input JSON Schemas no longer reject fields the schema doesn't declare.

`z.toJSONSchema()` (Zod v4) marks every object as closed (`additionalProperties: false`), but a `z.object()` ignores keys it doesn't name when it parses, rather than rejecting them. `buildManifest` now strips the closed-object marker from the schemas it emits so the two behaviors match — a step keeps validating successfully when an input it receives carries extra fields the step's `inputSchema` doesn't name. Typed catchalls (`z.object().catchall(...)`) are preserved.

Additive and non-breaking. If you previously added fields to a step's `inputSchema` only to admit extra incoming payload fields, that workaround is no longer required (though it remains harmless).
