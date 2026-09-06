---
"@sapiom/agent": patch
"@sapiom/agent-runtime": patch
---

Generated step-input JSON Schemas no longer force a nested field with a Zod `default` to be required.

`z.toJSONSchema()` (Zod v4) marks a defaulted field as required at every level, but a `z.object()` supplies the default on parse when the caller omits it. `buildManifest` already dropped such fields from the top-level `required`; it now does so at every level (nested objects, `items`, and `oneOf`/`anyOf`/`allOf` branches), matching how `additionalProperties: false` is already relaxed recursively. The runtime AJV pre-check applies the same relaxation, so a manifest built by an older SDK is corrected at validation time too.

Additive and non-breaking. A step whose `inputSchema` nests a defaulted field now accepts input that omits it — the same input its Zod parse already accepted — instead of failing the pre-check with a spurious "must have required property" error.
