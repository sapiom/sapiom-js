---
"@sapiom/harness": minor
---

Give every Studio project session the same writable coding-agent prompt and
map capabilities, with durable project ownership revalidated before launch
and resume.

**Breaking for embedders** (minor while `@sapiom/harness` is pre-1.0):
`HarnessSession.agentMapIdentity` now exposes only
`ProjectAgentSession { projectId, userId, sessionId }`. Replace branches on
`role` and `assignment` with neutral project identity. Optional
`projectBootstrap` carries startup status without granting authority. Valid
persisted legacy metadata is normalized while session/provider IDs, cwd,
title, transcript, and Canvas are preserved. Malformed or conflicting
authority fails closed; unavailable project scope prevents resume until the
current owner and root binding are valid again.

Persisted bootstrap failures with `scope_unavailable` are recognized on
restart, so valid conversation metadata is retained and can resume after
scope is restored.
