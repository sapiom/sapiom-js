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
levels and 64 active or explicitly re-referenced coordinator-owned sessions per
project. A parent can idempotently release its own child bindings by delegation
key, closing the exact coordinator-owned Harness session and recovering
capacity without granting access to manual or foreign sessions; unknown keys
converge as already released. After the coordinator close is durable, private
SessionManager ownership proof is pruned so release churn remains bounded
across restart. Request, binding, and acknowledged-delivery history use bounded
retention so long-lived projects do not dead-end on routine delegation, release,
or context refreshes. Exited and failed bindings remain durable for resume or
recovery without holding an active slot until re-referenced, or until explicitly
released. Any current project agent may explicitly reclaim up to sixteen dormant
coordinator-owned bindings in its project without supplying raw session IDs.
Each child is atomically rechecked as exited or failed; parent liveness is
intentionally irrelevant. This destructive recovery compacts coordinator and
private ownership state while retaining the ordinary Harness session history;
the released binding is no longer automatically resumable. Durable-history
capacity failures identify `release_dormant` in their recovery field, while an
all-active live cap does not suggest dormant cleanup. Delegation retries converge
until this explicit project-wide eviction boundary. Eviction expires request
receipts that referenced the released binding, so an old retry returns bounded
`request_key_expired` / `new_request_key` recovery; a fresh request key may
atomically create one new binding and real session for the same delegation key.
Dormant eviction emits content-free release telemetry when it commits. If later
private-marker cleanup fails, the result remains truthfully `released`, includes
the bounded cleanup error, and retains exact proof for idempotent cleanup after
the indicated recovery. Unfinished private cleanup remains discoverable by a
fresh bounded dormant sweep even after the original request receipt expires;
its proof becomes eligible for compaction only after the exact close succeeds.
