---
"@sapiom/harness": minor
"@sapiom/harness-desktop": patch
---

Unify Agent Studio project sessions around one ordinary coding-agent identity, make the project name open the shared Agent Map, and seed new projects through a durable, retry-safe bootstrap in the first `Plan Agents` session.

**Breaking for embedders** (minor while `@sapiom/harness` is pre-1.0):
`HarnessSession.agentMapIdentity` is now the role-neutral
`ProjectAgentSession { projectId, userId, sessionId }`; `role` and `assignment`
are no longer present. Valid persisted pre-upgrade session metadata is migrated
into the optional `projectBootstrap` lifecycle field and then removed. Retired
project-session HTTP aliases and public API names are removed; live clients use
the generic session routes.

**Migration:** stop branching on `agentMapIdentity.role` or `.assignment`, read
optional `projectBootstrap` only for bootstrap status, and use the generic
session routes. An
embedder that already owns a new session's first prompt should send
`initialUserInputPending: true` in the same `CreateSessionRequest`, so automatic
bootstrap yields before launch. New telemetry consumers should recognize the
neutral `project_agent.*` and `project_bootstrap.*` events. Valid legacy state
keeps its session/provider IDs, cwd, title, transcript, and Canvas; malformed or
conflicting authority is retained and fails closed. Downgrading does not restore
the superseded session authority model.
