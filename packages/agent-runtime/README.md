# @sapiom/agent-runtime

The host-agnostic core of the Sapiom orchestration engine: the graph-walker's
decision logic and the host interfaces it runs against (`ExecutionStore`,
`StepDispatcher`, `RuntimeObserver`). The same runtime drives both the server
engine and a local in-process runner — "one runtime, two hosts" — so a local
pass is real evidence, not a reimplementation.

This package is pure: it depends only on `@sapiom/agent` (protocol),
`ajv`, and `zod`. No persistence, transport, or scheduling — those are supplied
by a host through the interfaces.

A host executor reporting an `outcome: "threw"` completion should serialize the
caught value with `serializeStepCompletionError(error)`. This retains the
allowlisted fields that let the runner recognize terminal platform errors while
ordinary, author, and unknown errors keep the legacy retryable shape.
