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
