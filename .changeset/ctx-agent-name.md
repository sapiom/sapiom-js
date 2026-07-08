---
"@sapiom/agent": minor
"@sapiom/agent-core": minor
---

Rename the execution-context field `ctx.workflowName` → `ctx.agentName`.

**Breaking:** a step that reads `ctx.workflowName` must now read `ctx.agentName`. The value is unchanged — the agent's name (slug).
