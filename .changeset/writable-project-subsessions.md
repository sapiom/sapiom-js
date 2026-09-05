---
"@sapiom/harness": minor
---

Add `project_subsession_delegate` on Studio's project MCP endpoint, with delegate, focused-context refresh, release and dormant-release operations. Delegation supports 16 children per batch, four nesting levels and 64 active or explicitly re-referenced coordinator-owned sessions per project.

Readiness waits share a 30-second batch budget and return partial retry results with durable session identities. Treat uncertain kickoff delivery as terminal until acknowledged, and use a new request key when canonical content changes. Dormant cleanup remains recoverable after an earlier request expires.

**Breaking:** `AnalyticsEventType` includes new `subsession.*` events. Update exhaustive event consumers to handle the added values.
