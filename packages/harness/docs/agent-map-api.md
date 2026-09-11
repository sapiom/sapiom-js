# Agent Map identity and navigation

Studio uses one durable Agent Map per project. Read `GET /api/state` for
server-issued `studioProjects[].projectId` values and their exact
`workspaceScopes[].projectId` associations. A scope key identifies an allowed
workspace root; it is distinct from a durable project ID. Do not derive project
IDs from paths, names or node labels.

Send the boot token in `X-Harness-Token` for local API requests.

| Purpose                                   | Endpoint                                                              |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Read the saved map and shared proposal    | `GET /api/projects/:projectId/agent-map/workspace`                    |
| Resolve an implementation-backed map node | `GET /api/projects/:projectId/agent-map/nodes/:nodeId/implementation` |

Use the exact project and node IDs when resolving an implementation. Missing,
ambiguous or unavailable implementations remain unresolved. Viewing a project,
retrying its identity, inspecting a node or navigating to an agent does not
create, select, resume, bind or prompt a conversation. Explicit session tabs
open their exact ordinary conversation and its independent Canvas/Steps.

When identity is unavailable, Studio preserves the selected project and
conversation and offers **Reload projects**. An omitted catalog from an older
server follows the same recovery path. Upgrade older clients and servers
together; there is no second map protocol or fallback renderer.

The former `GET /api/workspaces/:workspaceKey/system-graph`, its `POST /refresh`
and `GET /navigation` handlers have been deleted. Without a valid boot token,
requests return 401. Authenticated requests return the generic API 404, replacing
the temporary 410 retirement response. Removed and unknown event types are
ignored before reaching browser state subscribers.

Shared workspace discovery, watch leases, the public `@sapiom/agent`
PackageInventory contract and individual-agent Canvas source scanning remain
independent of the removed project topology.

See the [authority and retirement record](../../../docs/plans/agent-studio-plan-first-agent-map/authority-retirement.md)
for validation evidence and the release recovery boundary. Installed-release
recovery requires a reverted change released at strictly higher package and
desktop versions; no in-place downgrade or lossless state reset is promised.
