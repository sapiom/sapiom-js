# Unified Agent Map journey interfaces

## Shared identity

```ts
type ProjectAgentSession = Readonly<{
  projectId: StudioProjectId;
  userId: UserId;
  sessionId: SessionId;
}>;
```

The server derives this identity for creation, resume, bootstrap, manual
sessions, and delegated sessions. Focus references are carried separately.

## Navigation seam

- Project-name selection renders `AgentMapPane` and does not change the active
  session ID.
- A session-tab selection activates that exact session and renders the ordinary
  conversation plus Canvas/Steps.
- The tab key is the durable session ID; there is one visible tab per live ID.

## Map and plan seam

- `GraphContentDigest` identifies canonical semantic graph content.
- `AgentMapVersionRef` binds `projectId`, `versionId`, and `contentDigest`.
- `ProjectAgentActorRef` records trusted user/session attribution.
- `ProjectBuildPlanVersion` is immutable and exact-map-bound.
- `AgentBriefVersion` is immutable and exact map/plan-bound.
- Current reads and historical exact-version reads are distinct operations.
- Apply/rebase/restore append before atomically advancing a pointer.

All sessions discover `agent_map_read`, `agent_map_validate`,
`agent_map_propose`, `build_plan_read`, `build_plan_validate`,
`build_plan_apply`, `build_plan_rebase`, `build_plan_brief_refresh`, and
`project_subsession_delegate`.

## Focused-context seam

A focused projection is allowlisted, deterministic, source-verified, and size
bounded. Authored prose is delimited as untrusted data. The projection excludes
secrets, raw evidence, local paths, connector values, unrelated history, and
arbitrary instructions. It supplements the common project-agent prompt.

## Delegation seam

Delegation authority comes from the caller's private project capability. Inputs
contain a stable request key, stable delegation key, assignment, and optional
exact focused-context reference; they contain no trusted project/user/session
selector. Durable claims fence creation, spawning, kickoff, acknowledgement,
release, and restart recovery. Nested delegation uses the same interface and
capabilities. Manual sessions remain outside coordinator ownership.

## Future journey contracts

Later shared-context, reconciliation, and existing-project adoption work must
consume these neutral identity, version, brief, and session contracts. Evidence
remains diagnostic; no later issue may add an approval or mode boundary before
ordinary coding or delegation.
