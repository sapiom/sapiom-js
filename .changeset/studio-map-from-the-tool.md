---
"@sapiom/harness": minor
"@sapiom/agent-map": minor
"@sapiom/harness-desktop": patch
---

Studio's project map now shows what your code does. It is computed by `sapiom_dev_map`, the same tool your coding agent can call, every time the map opens or the project's code changes. Nothing about the map is stored.

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
