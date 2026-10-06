# @sapiom/agent-map

## 0.3.0

### Minor Changes

- 600ac11: Studio no longer starts a Plan Agents session for a new project, and the unused build-plan and delegation tools are gone.

## 0.2.1

### Patch Changes

- 173850f: Agent Studio: the server now issues a project identity for every published workspace scope and every session. `WorkspaceScopeSummary.projectId` is required (`unassignedScopes` is gone; unsafe or unresolvable roots are omitted rather than published project-less), `HarnessSession.agentMapIdentity` is required, and persisted sessions without one are migrated on load to the deepest open root that contains their folder — or dropped when no project can own them. Default session titles ("acme-app", "acme-app 2", …) are assigned once at creation and persisted, so ending a sibling session no longer renames the others.

  Legacy sessions whose persisted identity metadata is malformed, or whose folder is not inside an open project root, are dropped on load; migration never creates a project for them.

## 0.2.0

### Minor Changes

- b052979: Add a browser-safe Studio host protocol and an offline MCP capability descriptor.
  The probe reports the installed package identity without starting the server; map
  features remain inactive until their implementations and Studio activation land.
- d9d6b13: Share Agent Map contracts without changing Studio behavior or saved state.
- 8a77b06: Share project identity, catalog locking, and canonical path matching while Studio retains discovery orchestration.

  Resolve paths asynchronously with briefly cached root probes, isolate unrelated filesystem failures, and preserve ownership errors before Studio registration or session creation.

- 5e9aacd: Share atomic map authoring and persistence, preserving the complete planning aggregate and Studio callbacks.
- 5b61bac: Share map schemas, graph validation, and immutable version helpers.
