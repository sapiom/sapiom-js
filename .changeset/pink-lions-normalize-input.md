---
"@sapiom/agent": patch
---

fix(agent): a defaulted field is no longer required at any depth in a published input schema

A step's published `inputSchema` listed a field as `required` even when it
carried a Zod `.default()`, as long as the field sat inside a nested object, an
array item, or a union/intersection branch. The engine's AJV pre-gate then
rejected a **partial** input for those fields while an entirely omitted input
validated — so `{ opts: {} }` failed where `{}` passed, contradicting the
authoring guidance that a default makes a field omissible. A `.prefault()` field
stayed required at every depth for the same reason.

`zodToJsonSchema` now converts in Zod's `io: "input"` mode — the mode that
describes what a caller may SEND — and runs the result through a new exported
`normalizeInputJsonSchema`, which recursively drops defaulted keys from
`required` and strips `additionalProperties: false`. Three consequences:

- `.default()`, `.prefault()` and `.catch()` fields are optional at every depth;
- `stepInputContract` / `workflowInputContract` now return the same normalized
  schema the manifest publishes, so a displayed contract (the Run form, inspect
  tooling) agrees with what the engine enforces;
- a step whose `inputSchema` contains a `.transform()` no longer fails the build
  with "Transforms cannot be represented in JSON Schema"; it is described by its
  input type, which is what a caller sends.

Redeploy an agent to publish the corrected schema.
