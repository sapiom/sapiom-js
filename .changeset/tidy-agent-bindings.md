---
"@sapiom/harness": minor
---

Expose protected `GET /api/projects/:projectId/agent-map/implementations` and `GET /api/projects/:projectId/agent-map/nodes/:nodeId/implementation` endpoints for binding summaries and exact local navigation targets. Resolve existing generated maps through their original agent associations without changing map history or starting another model pass.
