# Shared build-plan versions

Agent Studio stores one project Agent Map and one project build plan as
immutable version histories. Every ordinary project session receives the same
map and build-plan MCP tools. Trusted `{ projectId, userId, sessionId }` scope
comes only from the private session capability; tool input cannot select or
override it.

## Digests and exact references

`GraphContentDigest` identifies canonical graph semantics without project,
version, author, or timestamp metadata. An `AgentMapVersionRef` adds the exact
project and immutable version identity. Build-plan semantic digests cover only
normalized plan content, while version-record digests also cover exact map
binding, ancestry, authorship, origin, and creation time.

Current reads and historical reads are distinct. Historical reads require the
logical plan ID, immutable version ID, and semantic digest. No omitted version
is interpreted as “latest.” Restoring an old map or plan appends a new
`changeKind: "restored"` version; it never rewinds a current pointer or mutates
history.

## Authoring and concurrency

`build_plan_validate` executes the apply parser, deterministic ID mapping,
source checks, reducer, and contract validation without writing a receipt or
moving a pointer. `build_plan_apply` persists a semantic change, current
pointer, and complete replay receipt in one locked atomic replacement. An exact
semantic no-op stores only its receipt.

Request identity is scoped by the trusted project, user, session, and request
ID. Retrying identical content returns the original result; changing content
under the same request ID fails. Concurrent same-source edits merge only when
their stable touch sets are disjoint. Overlaps return stable conflict IDs and
paths. A map-version change always requires `build_plan_rebase`, including
explicit resolutions for every invalidated assignment, repository intent, or
dependency; intent is never silently dropped.

Immutable map and plan histories are each bounded at 1,024 versions and are
never silently trimmed. Exhaustion returns terminal `quota_exceeded` with
`manual_intervention` recovery so callers do not retry forever; an operator
must preserve/archive the project history before a future storage migration can
raise or replace the bound.

Validation warnings such as missing assignments, missing briefs, or unresolved
decisions are diagnostic. They do not restrict coding, tool discovery, or
session creation.

## Reserved focused-brief seam

SAP-3149 established append-only brief histories for focused-context work. A
brief has a stable logical ID and a neutral focus
scope: either a canonical workstream or an ad-hoc delegation whose parent scope
may identify nested delegation. Each scope has an explicit active or retired
pointer. Retirement preserves history, and reactivation appends the next
version against that retained history. New and migrated aggregates start with
empty brief histories.

## Focused brief compilation and refresh

`build_plan_brief_refresh` deterministically joins one exact current map version
and one exact current plan version. It compiles either the canonical top-level
workstreams or explicit ad-hoc/nested delegation scopes, appends only changed
brief versions, and retains explicit retired pointers and immutable history.
Plan apply and rebase commit before their best-effort canonical refresh, so a
bounded compiler diagnostic never rolls back accepted plan intent; the refresh
tool can be retried independently and idempotently.

Each logical brief retains at most 1,024 immutable versions; exhausting that
history returns terminal `quota_exceeded` with `manual_intervention` recovery.
The newest 256 brief-refresh receipts remain replayable, while older receipts
expire into tombstones and return `request_id_expired`, requiring a new request
ID instead of replaying the original result.

Brief fingerprints separate owned nodes, relevant nodes, input/output
contracts, relationships, resources, milestones, shared plan content, and
assignment content. Impact and freshness are diagnostic only. They never
change tools, session writability, or implementation authority.

The optional focused-session prompt overlay is an allowlisted, deterministic,
size-bounded projection. Authored strings are delimited as untrusted data,
delimiter-shaped and Unicode format characters are escaped, sensitive/path-like
values are redacted, and oversized collections are truncated with a diagnostic.
A project session without an overlay receives the common project-agent prompt
byte-for-byte unchanged and keeps the same tool surface.

Trusted hosts attach an overlay by calling `serializeFocusedSessionContext`
with the exact map, plan, and brief versions, checking its discriminated result,
and passing the branded `projection` through `TrustedSessionCreateOptions` or
`TrustedSessionResumeOptions`. Focused context is rejected outside a trusted
project-agent identity. Ordinary callers cannot construct the branded value,
and authored data must never be appended to a prompt by another serialization
path.

## Writable project subsessions

Every ordinary project session discovers `project_subsession_delegate` beside
the shared map, plan, and brief tools. The operation creates, reuses, or
releases one to sixteen ordinary writable sessions. Each child receives the same common
project-agent prompt, coding capabilities, project tools, and delegation tool,
so nested delegation follows the same path. An exact assignment, map node, or
brief may focus the child, but focus never changes its tools or authority.
Delegation is bounded to four levels and 64 active or explicitly re-referenced
coordinator-owned sessions per project. Dormant exited or failed bindings retain
their exact resume identity without holding an active slot until they are
re-referenced. A parent can idempotently release its own child bindings by
delegation key to close their real Harness sessions and recover capacity; it
cannot name arbitrary session IDs or release another parent's or a manual
session. Unknown or expired keys converge as already released without exposing
a session identity.

Callers provide both a request key and a delegation key. Identity is scoped by
the private session capability to the trusted project and parent session.
Identical retries converge on the same durable binding and real Harness session
ID until an explicit project-wide dormant eviction; changing canonical request
or binding content under an existing key otherwise fails explicitly. All binding
IDs and session IDs for a bounded batch are reserved in one durable transaction
before the first process is spawned.
Older request receipts compact into bounded key tombstones. User-closed
bindings compact into bounded ownership tombstones once no retained receipt
references them; an explicit release finalizes immediately to the same
tombstone while its receipt retains deterministic replay. Exited and failed
bindings remain available for the coordinator's ordinary resume and recovery
paths until explicitly released. Once the durable coordinator close succeeds,
SessionManager prunes the exact private ownership marker and close tombstone; a
failed final cleanup retains that proof for the next idempotent retry. The
oldest tombstones expire as the retention window advances, so routine
delegation, release, and focused-context refreshes cannot permanently exhaust a
project.
Proven acknowledged or unsent delivery epochs are likewise pruned when a newer
focused-context delivery replaces them; ambiguous delivery evidence is retained.

If exited or failed bindings fill durable binding history, any current project
session may explicitly invoke the bounded `release-dormant` operation. The
coordinator selects at most sixteen eligible records inside the
capability-derived project; the request accepts no session IDs and never selects
active bindings or manual sessions. Parent liveness is intentionally irrelevant:
this explicit project-wide destructive operation relinquishes dormant delegation
resume identity even when the original parent is active. It retains the ordinary
Harness conversation/session history, but compacts the coordinator binding and
ends automatic resume through that binding. The sweep remains idempotent and
restart-safe, while prior request receipts referencing an evicted binding become
bounded expiry tombstones. Retrying one of those keys returns
`request_key_expired` with `new_request_key`; a fresh request key may atomically
create one new binding/session for the same delegation key. Durable-history
capacity errors expose the explicit `release_dormant` recovery code; an
all-active live cap continues to require session inspection instead of suggesting
an inapplicable dormant cleanup. A bounded private-marker cleanup error may
accompany an already-`released` result because eviction is durable first. Exact
cleanup proof remains available so the same sweep can finish after the indicated
recovery or inspection without changing the release outcome.

The coordinator waits for canonical adapter readiness and exact transcript
identity, then uses fenced spawn and delivery epochs to submit one kickoff.
Delivery states distinguish pending, claimed, submitted without acknowledgement,
acknowledged, and uncertain. An uncertain delivery is never resent blindly.
Exact focused references are checked before delivery, and stale context returns
an explicit refresh path without closing the session or changing writability.

Coordinator recovery starts from its own two-sided private binding marker. It
does not infer ownership from cwd, title, assignment, map membership, or process
similarity, and it never adopts, renames, resumes, closes, or removes an
unrelated manual session. Tabs remain projections of ordinary live sessions,
deduplicated by the real session ID and exact server-derived project identity.

Delegation telemetry contains only event names, project/session identifiers,
and bounded error codes. Task text, kickoff context, focused prose, source,
paths, secrets, credentials, and raw adapter output are excluded.
