---
"@sapiom/agent": minor
"@sapiom/agent-runtime": patch
---

A defaulted field is no longer required at any depth in an input schema

A step's published `inputSchema` listed a field as `required` even when it
carried a Zod `.default()`, as long as the field sat inside a nested object, an
array item, or a union/intersection branch. An AJV pre-gate then rejected a
**partial** input for those fields while an entirely omitted input validated —
so `{ opts: {} }` failed where `{}` passed, contradicting the authoring guidance
that a default makes a field omissible. A `.prefault()` field stayed required at
every depth for the same reason.

`zodToJsonSchema` now converts in Zod's `io: "input"` mode — the mode that
describes what a caller may SEND — and runs the result through a new exported
`normalizeInputJsonSchema`, which drops defaulted keys from `required` and
strips `additionalProperties: false` on every schema node it can reach.

**If you call `zodToJsonSchema` directly**, its output changes: a smaller
`required` set, no `additionalProperties: false` from `z.strictObject()`, a
`.pipe()`/`.transform()` described by its input type rather than its output
type, and a schema containing a `.transform()` now converting successfully where
it previously threw `Transforms cannot be represented in JSON Schema`. Every
change is in the "what may a caller send" direction. If you need the
value-a-parse-returns schema instead, call `z.toJSONSchema(schema)` yourself.

Also:

- `stepInputContract` / `workflowInputContract` return the same normalized
  schema the manifest publishes, so a displayed contract (a Run form, inspect
  tooling) agrees with what a pre-gate enforces.
- `@sapiom/agent-runtime`'s step-input pre-gate normalizes the manifest it is
  handed, so an agent deployed on an earlier version accepts a partial nested
  input without being redeployed. A `.prefault()` field still needs a redeploy —
  the older schema records no `default` keyword for it to key off.
