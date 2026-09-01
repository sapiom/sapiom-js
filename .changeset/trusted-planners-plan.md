---
"@sapiom/harness": minor
---

Add trusted, project-scoped Agent Map planner sessions with deterministic
resume-or-create/fresh resolution, focused path-free context, a durable
automatic-greeting state machine, FIFO user input, bounded lifecycle telemetry,
public planner session/greeting state, and per-session ingest capabilities that
cannot be replayed across PTYs or used for host `/api` mutations.

**Breaking:** generic `POST /api/sessions` now strictly rejects unknown fields,
so clients can no longer attach planner metadata to a generic create request.
Generic planner input and resume routes also reject planner sessions. Migrate
planner clients to the project-scoped `/api/projects/:projectId/planner-sessions`
open, message, and greeting-retry routes; generic coding-agent sessions are
unchanged.
