---
"@sapiom/harness": minor
---

Add trusted, project-scoped Agent Map planner sessions with deterministic
resume-or-create/fresh resolution, focused path-free context, a durable
automatic-greeting state machine, FIFO user input, bounded lifecycle telemetry,
public planner session/greeting state, and per-session ingest capabilities that
cannot be replayed across PTYs or used for host `/api` mutations. Rehydrated
planner replacements atomically inherit the exact predecessor FIFO while their
focused brief can reuse an older recorded ancestor.

**Breaking:** generic `POST /api/sessions` now strictly rejects unknown fields,
so clients can no longer attach planner metadata to a generic create request.
Generic planner input, resume, and adopt routes also reject planner-owned
sessions. Generic adopt additionally rejects every conflicting current owner
or durable historical vendor identity, including ordinary pre-`/clear` and
pre-`/resume` aliases, with a bounded 409 before adapter probing. Migrate
planner clients to the project-scoped open, message, and greeting-retry routes
under `/api/projects/:projectId/planner-sessions`.

All coding-agent sessions now pin
vendor identity to a durable session owner: conflicting `SessionStart` claims
are rejected. The only rotation exception is a short-lived, one-shot
server-observed `/clear` or `/resume` terminal gesture; `/resume` picker input
may refresh its soft window only within a bounded hard deadline.
