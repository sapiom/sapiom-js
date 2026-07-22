---
"@sapiom/tools": minor
---

Forward activity-trace context on capability and model calls. `Attribution` gains `parentSpanId`, `executionId`, and `stepOrder` — emitted as `x-sapiom-parent-span-id` / `x-sapiom-execution-id` / `x-sapiom-step-order`, and read ambiently from `SAPIOM_PARENT_SPAN_ID` / `SAPIOM_EXECUTION_ID` / `SAPIOM_STEP_ORDER` (`attributionFromEnv`) — so calls nest under the calling run and step. Applied once at the shared transport, so every capability inherits it.

Deprecates `agentName`, `agentId`, and `traceExternalId` (a free-form label / legacy correlation field). They still forward for backward compatibility; prefer `traceId` plus the new fields.
