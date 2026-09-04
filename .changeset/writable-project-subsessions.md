---
"@sapiom/harness": minor
---

Add capability-scoped `project_subsession_delegate` support for creating,
reusing, or releasing bounded batches of ordinary writable project sessions. Delegations use
durable parent/key bindings, canonical request digests, transactional spawn and
kickoff claims, exact focused-context references, readiness-gated delivery,
restart recovery, nested common-tool composition, and real session IDs.

**Breaking for embedders** (minor while `@sapiom/harness` is pre-1.0): internal
session hosts that construct the Agent Map MCP router must provide the shared
`SubsessionCoordinator`; session hosts that tail transcript-backed adapters must
also complete exact runtime identity correlation before trusted background
kickoff. No REST delegation endpoint or model-controlled project/session
selector is added.

Manual sessions remain outside coordinator ownership. Consumers should treat
`uncertain` kickoff delivery as terminal until an exact persisted
acknowledgement arrives, and should use a new request/delegation key when the
corresponding canonical content changes. Nested delegation is bounded to four
levels and 64 live or resumable coordinator-owned sessions per project. A
parent can idempotently release its own child bindings by delegation key,
closing the exact coordinator-owned Harness session and recovering capacity
without granting access to manual or foreign sessions. Request, binding, and
acknowledged-delivery history use bounded retention so long-lived projects do
not dead-end on routine delegation, release, or context refreshes. Exited and
failed bindings remain durable for resume or recovery until explicitly
released.
