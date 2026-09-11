---
"@sapiom/harness": minor
---

**Breaking for HTTP clients** (minor while `@sapiom/harness` is pre-1.0): retire
the documented project System Graph endpoints. Authenticated requests to all
three routes now return the generic JSON API `404` response:

- `GET /api/workspaces/:workspaceKey/system-graph`
- `POST /api/workspaces/:workspaceKey/system-graph/refresh`
- `GET /api/workspaces/:workspaceKey/system-graph/navigation`

The boot token remains required. These requests no longer resolve a scope,
read or refresh a legacy graph, or activate graph watchers.

Migrate to `GET /api/projects/:projectId/agent-map/workspace` for the durable
Agent Map and shared proposal, and
`GET /api/projects/:projectId/agent-map/nodes/:nodeId/implementation` for exact
implementation navigation. Obtain server-issued project IDs from
`GET /api/state`; a workspace key, path or display name is not a project ID.
The durable APIs do not use the old process-memory graph snapshots or revision
matching protocol.

This release includes the matching Studio client recovery: an unresolved
project shows **Agent Map unavailable** with **Reload projects**, preserves its
conversation, and no longer starts or selects a session on a project click.
Shared workspace discovery, explicit session creation and ordinary session
navigation remain available independently of the retired graph.
