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

`StepInputValidationError` now exposes a dedicated bounded wire payload with
stable `code`, `version`, `stepName`, and `retryable: false` fields while its
ordinary JSON representation continues carrying raw Zod issues for in-process
callers. Hosts receive a normalizing `parseNonRetryableStepErrorPayload`
registry plus `serializeStepCompletionError()` for completion reporters, and
may implement the additive atomic active-dispatch failure capability required
for terminal settlement. Older stores omit that capability and retain the
legacy retry path.
