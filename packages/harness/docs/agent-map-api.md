# Agent Map identity and navigation

Studio draws each project's map from the code. Nothing about agents or edges is
stored: `GET /api/projects/:projectId/map` runs `sapiom_dev_map`'s scan
(`describeProject` + `buildMap` from `@sapiom/mcp/map`) in process for the
project's folder on every read. A coding agent calling `sapiom_dev_map` sees the
same map.

Read `GET /api/state` for server-issued `studioProjects[].projectId` values and
their exact `workspaceScopes[].projectId` associations. A scope key identifies an
allowed workspace root; it is distinct from a durable project ID. Do not derive
project IDs from paths or names. Send the boot token in `X-Harness-Token`.

| Purpose                   | Endpoint                                     |
| ------------------------- | -------------------------------------------- |
| Read the map              | `GET /api/projects/:projectId/map`           |
| Read the map at a git ref | `GET /api/projects/:projectId/map?ref=<ref>` |

The response is `{ projectId, displayName, map, git }`. `map` is exactly the
tool's output (systems, agents, edges with their code evidence, unresolved
calls), with `map.root` set to the folder the project was opened from. `git` is
`{ branch, branches }` in a git repository and `null` outside one. Errors:
`404 project_not_found`, `409 project_unavailable` (the folder is not open),
`400 INVALID_REF` or the scan's own code for a ref git does not know, and
`500 map_failed`.

While a project's map has been read, Studio watches its folder and publishes
`{ type: "project-map.changed", projectId }` on `/ws/events` after a source or
agent-inventory change (debounced 500 ms). The event carries no map; the client
reads the route again.

Viewing a project, choosing a ref, refreshing, picking an agent or opening its
modal does not create, select, resume, bind or prompt a conversation. An agent
on the map opens by its folder (`map.root` joined with the agent's `path`), the
same path the agent list uses.

The stored map is removed: the `/api/projects/:projectId/agent-map/*` routes
(workspace, implementations, node implementation, initialization and its retry),
the `/mcp/agent-map` endpoint with its `agent_map_read`, `agent_map_validate` and
`agent_map_propose` tools, and the `agent-map.proposal.changed` and
`agent-map.initialization.changed` events. Requests to the removed routes return
the generic API 404. Existing `~/.sapiom/harness/agent-map/projects/` folders are
no longer read and can be deleted.

The former `GET /api/workspaces/:workspaceKey/system-graph`, its `POST /refresh`
and `GET /navigation` handlers were deleted earlier and still return the generic
API 404. Removed and unknown event types are ignored before reaching browser
state subscribers.
