# Project system graph HTTP contract

Agent Studio exposes a local, read-only dependency graph for each opened
Project. The route keeps its historical `/workspaces/` name, but a
`workspaceKey` identifies one exact Project root in the current Studio server.
It is an opaque server-issued value, not a path and not an identifier clients
should derive.

The API is local to the Harness process and sits behind the same boot-token
middleware as the rest of `/api`. Send the token in `X-Harness-Token`. An
unknown or retired key returns `404 { "error": "Workspace not found" }` without
scanning the supplied string as a path.

## Discovering a Project key

`GET /api/state` includes an optional `workspaceScopes` array:

```ts
interface WorkspaceScopeSummary {
  workspaceKey: string;
  cwd: string;
}
```

The browser joins a displayed Project root to the entry with the same `cwd`
and then uses its `workspaceKey`. Filesystem paths stop at this state boundary:
system-graph snapshots and change events never contain a Project root or agent
source path.

## Reading and refreshing

```http
GET  /api/workspaces/:workspaceKey/system-graph
POST /api/workspaces/:workspaceKey/system-graph/refresh
```

`GET` returns the current process-memory snapshot. A cold read waits for the
initial projection, concurrent cold reads share that build, and later reads
reuse it. `POST .../refresh` reruns registry prerequisites, requests a fresh
projection, waits for that attempt, and is the explicit recovery action after
an error. Both successful routes return `200` with a
`SystemGraphSnapshot`:

```ts
interface SystemGraphSnapshot {
  workspaceKey: string;
  revision: number;
  state: "building" | "ready" | "stale" | "degraded";
  graph: SystemGraph | null;
}
```

Revisions increase for accepted lifecycle transitions. They are monotonic for
one `workspaceKey` during one server process, including a remove-and-reopen,
but they are not durable across a Studio restart.

| State      | `graph`                                 | Meaning                                                                                                                                      |
| ---------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `building` | `null` until a usable projection exists | The first projection, or a refresh without last-good data, is in progress.                                                                   |
| `ready`    | non-null                                | The current projection completed and is cacheable.                                                                                           |
| `stale`    | non-null                                | A last-good graph remains usable while refresh is running or after refresh failed.                                                           |
| `degraded` | partial graph or `null`                 | Projection was not cacheable, or no usable graph could be built. The UI may offer one bounded automatic recovery followed by explicit retry. |

Every `200` response also carries:

```http
X-Sapiom-System-Graph-Cache: complete | degraded
```

`complete` means the returned snapshot is `ready`. `building`, `stale`, and
`degraded` all report `degraded`; the header is a health/cacheability signal,
not an HTTP cache directive.

## Graph payload

`SystemGraph` is path-free and has `kind: "system"`. Its scope repeats only the
opaque key. Nodes contain an `id`, Project-scoped `agentKey`, and display
`label`. Edges are static `invokes` relationships with a `blocking` or `async`
mode. Blocking and asynchronous calls between the same pair remain distinct in
the JSON even when the UI groups them into one connector.

Projection can remain useful while reporting warnings:

| Warning code                  | Meaning                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `unresolved-target`           | A literal target does not resolve to an agent in the selected Project.                            |
| `dynamic-target`              | Source contains a call whose target cannot be proven statically.                                  |
| `duplicate-edge`              | The same mode-specific relationship was discovered more than once.                                |
| `projection-failed`           | A relationship projection failed and the remaining graph was preserved.                           |
| `duplicate-agent-key`         | More than one contained agent proposed the same key; local fallback identities disambiguate them. |
| `inventory-extraction-failed` | One agent could not be enriched, so the remaining inventory was returned.                         |

## Freshness event

After an accepted transition, the Harness event WebSocket publishes:

```ts
{
  type: "system-graph.changed";
  workspaceKey: string;
  revision: number;
  state: "building" | "ready" | "stale" | "degraded";
}
```

The event is an invalidation hint. Clients compare its key and revision with
the displayed snapshot and refetch when newer; the graph itself is not sent on
the event bus.

Opening a Project graph starts one session-independent recursive filesystem
watcher for that Project. This is additional to session and Canvas watchers so
the graph stays current even when no coding-agent session is open. Source and
inventory events are debounced. Platforms without recursive watch support, or
watchers that later error, fall back to asynchronous polling. Removing a
Project retires its watcher and process-memory snapshot once Studio no longer
exposes that scope.
