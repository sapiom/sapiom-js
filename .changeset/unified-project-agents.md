---
"@sapiom/harness": minor
---

Unify Studio project sessions around one ordinary coding-agent identity and
make the project name open the shared Agent Map without starting a session.
Conversation tabs restore their exact session and Canvas independently of the
map and workflow Steps selection.

**Breaking for embedders** (minor while `@sapiom/harness` is pre-1.0):
`HarnessSession.agentMapIdentity` is now the role-neutral
`ProjectAgentSession { projectId, userId, sessionId }`. Stop branching on the
former `role` or `assignment` fields. Valid persisted legacy metadata is
normalized while session/provider IDs, cwd, title, transcript, and Canvas are
preserved. Malformed or conflicting authority fails closed. Optional
`projectBootstrap` describes lifecycle state only. Generic session routes
revalidate project ownership on resume; migrated startup queues retain their
durable FIFO input boundary during the coordinator transition.
