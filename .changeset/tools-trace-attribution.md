---
"@sapiom/tools": patch
---

Forward activity-trace context on capability and model calls. `Attribution` gains `activityTraceId`, `parentSpanId`, `executionId`, and `stepOrder` — emitted as `x-sapiom-activity-trace-id` / `x-sapiom-parent-span-id` / `x-sapiom-execution-id` / `x-sapiom-step-order`, and read ambiently from the matching `SAPIOM_*` env vars (`attributionFromEnv`) — so calls nest under the calling run and step. Applied once at the shared transport, so every capability inherits it.

`activityTraceId` is deliberately a **separate field/header from `traceId`**: `traceId` (`x-sapiom-trace-id`) remains the Core transaction trace, while `activityTraceId` (`x-sapiom-activity-trace-id`) is the client-minted activity/execution trace — kept apart so the two never collide on one header.

Deprecates `agentName`, `agentId`, and `traceExternalId` (a free-form label / legacy correlation field). They still forward for backward compatibility.
