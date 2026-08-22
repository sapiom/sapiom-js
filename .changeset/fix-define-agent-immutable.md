---
'@sapiom/agent': patch
---

fix(agent): defineAgent no longer mutates the caller's definition object

`defineAgent` now builds and returns a shallow copy instead of mutating the
object passed in. Previously it reassigned `def.steps` (when folding an
agent-level `inputSchema`) and attached the `AGENT_DEFINITION_BRAND` symbol
directly onto the caller's object, so both mutations were observable on the
original reference the caller still held. Callers should keep using the value
returned by `defineAgent` (they already do); the object passed in is now left
untouched. Closes #572.
