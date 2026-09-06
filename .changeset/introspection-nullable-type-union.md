---
"@sapiom/agent": patch
---

Fix `exampleFromJsonSchema` skeleton generation for JSON Schema `type` unions
that include `null` (e.g. `{ type: ["string", "null"] }` from Zod `.nullable()`).
Previously the array form fell through to `null`, so workflow input prefills
showed `null` instead of a type-appropriate placeholder.
