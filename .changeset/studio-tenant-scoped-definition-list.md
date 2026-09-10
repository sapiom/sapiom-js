---
"@sapiom/harness": minor
---

Resolve linked agents from one tenant-scoped definitions list per poll instead
of a by-id lookup per agent: definitions the signed-in account cannot see are
never requested and show as unavailable in Studio. `WorkflowInfo` gains an
optional, serve-time `definitionAccess` field (never persisted).
