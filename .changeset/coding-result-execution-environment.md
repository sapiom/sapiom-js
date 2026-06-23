---
"@sapiom/tools": minor
"@sapiom/orchestration-core": patch
---

**BREAKING (`@sapiom/tools`):** align the coding-run resume payload with the shape a resumed step actually receives. `CodingResultPayload` now carries `executionEnvironment: { type, id } | null` instead of `sandbox: { name, workspaceRoot }`. Re-attach a resumed run's sandbox with `ctx.sapiom.sandboxes.attach(result.executionEnvironment.id)` (for a `blaxel_sandbox`).

Adds `codingResultSchema` (runtime validation of the resume payload), `toResumePayload`, `ExecutionEnvironmentRef`, and `EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX`. The stub client now emits the same payload shape a resumed step receives, so a step written against the local loop runs identically once deployed.

The `coding-pause` template and its guidance are updated to the new shape.
