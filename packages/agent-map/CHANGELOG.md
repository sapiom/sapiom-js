# @sapiom/agent-map

## 0.4.0

### Minor Changes

- 45c2846: Studio's project map now shows what your code does. It is computed by `sapiom_dev_map`, the same tool your coding agent can call, every time the map opens or the project's code changes. Nothing about the map is stored.

  - **Systems** are agents joined by the launches, events, signals and timers the code proves, drawn as containers. Agents in no system stand alone. Every agent on the map is a real agent folder, so **Open agent** and **Open in Finder** work on every node.
  - **Agents** show **Deployed** or **Draft** from your signed-in account, a dot when they changed since the version you are looking at, and the resources they share with another agent.
  - **Versions** come from git. In a git project, the project bar has a version selector (Working copy, `HEAD`, branches) and a refresh.

  Removed, with the stored map:

  - the automatic map generation for new projects;
  - the "Version N" history;
  - the proposal tools and links between map nodes and agents;
  - the `agent_map_read`, `agent_map_validate` and `agent_map_propose` session tools;
  - the `/api/projects/:id/agent-map/*` routes.

  `@sapiom/agent-map` keeps the Studio project catalog, root bindings and the current-workspace preference. Its map, proposal, version, binding and build-plan exports are removed. Existing `~/.sapiom/harness/agent-map/projects/` folders are no longer read and can be deleted.

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
