# Agent Studio unified Agent Map

Status: implemented by SAP-3148 through SAP-3151; SAP-3152 verifies and
reconciles the cutover.

## Product authority

Every Studio project session is one ordinary writable project agent. Its
trusted principal is `{ projectId, userId, sessionId }`, derived by the server.
Assignment, map-node, and focused-brief references are context, never
authorization. Every project session receives the same project-agent prompt,
Agent Map tools, build-plan tools, coding surface, and delegation tool subject
to normal project isolation and capability lifecycle.

The project owns one durable Agent Map and one current project build plan.
Sessions read and update that shared state through validated tools. A clear
implementation request proceeds directly. Agents update the map or plan only
when work changes architectural boundaries, ownership, contracts, resources,
connectors, artifacts, sequencing, or cross-agent flow. Internal code choices
remain local.

## Navigation

The project name selects the production Agent Map. That selection is a
deterministic read of durable state and never creates, resumes, focuses, or
prompts a session. Every session tab selects exactly one ordinary conversation
and its Canvas/Steps surface. A new project starts with one ordinary session
initially named `Plan Agents`; the name and first position grant no special
authority.

## Bootstrap and continuous maintenance

Project creation durably schedules one evidence-first bootstrap turn for the
first ordinary session when the map is meaningfully empty. Attempts, readiness,
preemption, retry, restart recovery, and delivery correlation are durable and
idempotent. User input remains usable and wins races without being discarded.
Opening the map does not trigger model work. After bootstrap, the common prompt
makes map maintenance a responsibility of every session.

## Versions, briefs, and delegation

Map, plan, and brief content use canonical digests and project-bound immutable
version references. Accepted changes append a version and atomically advance a
current pointer. Concurrent writes use exact expected versions; stale overlap
conflicts require reread/rebase. Restoration appends a new record carrying
`restoredFromVersionId`; history is never rewritten or rewound.

Focused briefs are deterministic, bounded, exact-source context overlays. They
focus a mission, scope, dependencies, contracts, deliverables, constraints, and
acceptance evidence without changing prompt or tools. Sessions without briefs
retain full capabilities and global context.

Any project agent may delegate writable work. The coordinator uses stable
project/parent/key bindings, durable spawn claims, exact session reuse,
readiness-gated kickoff delivery, acknowledgement, bounded retention, nested
delegation, and explicit stale-context recovery. Cleanup owns only sessions it
created; unrelated manual sessions are never adopted or mutated.

## Evidence boundary

Source and runtime evidence may verify or challenge project intent but never
silently becomes intent. The per-agent execution graph remains the authority for
internal steps and ordinary tool calls. The project map stays at architectural
altitude.

## Security and observability

Trusted scope never comes from model arguments. Capabilities are private,
project/session-scoped, rotated on resume, revoked on exit, and rejected across
projects. Telemetry records bounded lifecycle outcomes and identifiers only; it
must not contain prompts, plan prose, source text, paths, credentials, connector
payloads, or raw provider errors.
