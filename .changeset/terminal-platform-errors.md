---
"@sapiom/agent": minor
"@sapiom/agent-runtime": minor
"@sapiom/agent-core": patch
---

Add a closed, versioned retry-classification contract for platform-owned step
errors. `CTX_SHARED_SIZE_LIMIT_EXCEEDED` and
`STEP_INPUT_VALIDATION_FAILED` now settle executions terminally without
consuming workflow retries; unknown, author, and capability errors keep the
legacy retry behavior.

`StepInputValidationError` now serializes stable `code`, `version`,
`stepName`, and `retryable: false` fields without exposing raw Zod issues.
Hosts receive a normalizing `parseNonRetryableStepErrorPayload` registry, and
`ExecutionStore` gains the atomic active-dispatch failure transition required
to prevent partial settlement from reaching a deadline sweeper.
