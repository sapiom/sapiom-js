---
"@sapiom/agent-core": minor
---

Adds `inspectStep(opts, client)` — fetches one step attempt's full-fidelity `input`/`output`/`error`/`logs` (`GET /executions/:id/steps/:stepId/io`), at a higher size cap than `inspect()`'s own `steps[]` bounds its aggregate read to. Reach for it when a step's fields on the execution projection look truncated.

- New exported `inspectStep`, `InspectStepOptions`, `StepIoDetail`, and `decodeStepIoDetail` (the tolerant decoder, mirroring `decodeExecutionProjection`'s degradation posture).
- `StepProjection` gains an optional `id` field (the step-attempt row id) — previously decoded from the wire but silently dropped; needed to call `inspectStep` from an `inspect()` read. `null` on a read from a server that doesn't report it — existing consumers are unaffected.
