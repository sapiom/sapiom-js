# `GET /api/workflows/:path/graph` — the workflow-keyed canvas route

**Status:** shipped (IA-01, epic SAP-2926 § Server gaps).
**Implementation:** `src/server/workflow-graph.ts`, derivation in `src/core/canvas-render.ts`.
**Consumer:** SAP-2931 (selection-driven canvas) — this note is the contract to wire against.

## Why it exists

The canvas has only ever been reachable through a session. Boards live at
`/canvas/:harnessSessionId/` and resolve by the session's *current binding*
(`src/server/canvas.ts`), so an agent that has never hosted a session has no board at all,
and you cannot read agent F's board while working in agent B's session.

This route is a second, **session-free** entry point onto the *same* derivation. It is not a
new renderer: it calls `deriveWorkflowCanvas` (`src/core/canvas-render.ts`) — the exact
pipeline the render-file write path uses — so the document it returns is **byte-identical** to
the render a bound session's canvas serves for the same workflow. A test locks that parity
(`src/core/canvas-render.test.ts`, "produces the byte-identical document the session-bound
render writes to disk"). Nothing is written to disk.

## Request

```
GET /api/workflows/:path/graph
X-Harness-Token: <boot token>
```

- `:path` is the agent's **absolute directory path**, URI-encoded into a single segment:

  ```ts
  fetch(`/api/workflows/${encodeURIComponent(agentPath)}/graph`)
  ```

  This is the encoding `/api/workflows/:id/input-contract` and `/api/workflows/:id/deploy`
  already use (`web/src/lib/api.ts`) — Express matches on the raw path and decodes the param,
  so an encoded `/` never splits the route. A query parameter was the alternative; the encoded
  segment was chosen to match the epic's stated URL and the routes already beside it.

- Mounted under the same `/api` boot-token middleware as the rest of the REST surface, so it
  needs the `X-Harness-Token` header. **It is therefore a `fetch` target, not an `<iframe src>`**
  — an iframe cannot carry the header, which is exactly why `/canvas/:sessionId/` is mounted
  unauthenticated. Render `document` via `srcdoc` (or draw `graph` yourself); do not point an
  iframe `src` at this URL.

## Response

`200 application/json`:

```ts
interface WorkflowGraphResponse {
  path: string;                        // resolved absolute agent directory
  name: string;                        // registry display name = the panel title
  status: "ok" | "empty" | "preparing" | "error";
  graph: CanvasGraph | null;           // src/core/canvas-graph.ts; null unless status === "ok"
  enrichment: CanvasEnrichment | null; // src/core/canvas-enrichment.ts
  reason: string | null;               // set for "empty" and "error"
  cached: boolean;                     // extraction came from the warm cache, no child process
  document: string;                    // the finished canvas HTML document — see below
}
```

`document` is present for **every** status, including `empty`: an empty board is still a
renderable page, never a hole. For `ok` it is the workflow panel; for `preparing` the calm
"Preparing your agent" placeholder; for `error` the honest error panel; for `empty` the same
"Nothing rendered yet" message document `src/server/canvas.ts` serves, with `reason` as its
subtitle.

## Status codes

| Code | When | Body |
|---|---|---|
| `200` | Registered agent, any board state | `WorkflowGraphResponse` — read `status` |
| `400` | `:path` missing/blank, relative, or containing a `..` segment; or `sapiom.json` resolves outside the agent directory | `{ error }` |
| `404` | The path is **not a registered workflow** | `{ error: "agent not found" }` |

### `status` values (all `200`)

| `status` | Meaning | `graph` |
|---|---|---|
| `ok` | `sapiom.json` valid, graph extracted | the graph |
| `empty` | Registered, but no readable/parseable `sapiom.json` — or the directory is gone | `null` |
| `preparing` | Dependencies not installed yet; extraction skipped on purpose | `null` |
| `error` | Extraction ran and failed; `reason` says why | `null` |

**Missing `sapiom.json` is a `200 empty`, not a `422` and not a `404`.** That follows the
epic's Project-icon precedent — *absent ⇒ empty, not an error*. The consequence for a consumer
is the one that matters: `404` means **"this agent is not registered"** and nothing else, so an
empty board can never be mistaken for a missing route. Distinguish a real board from an empty
one by `status`, never by the status code.

## Path validation

`:path` is a filesystem path arriving from a client, so the guards run in this order and
**every one of them precedes any disk read**:

1. Blank/missing → `400`.
2. `hasTraversalSegment(raw)` (`src/core/path-safety.ts`, segment-aware — `a..b` is a normal
   name) → `400`. Checked on the **raw** value, before resolution: `/proj/agent/../agent`
   normalizes onto a registered path, and resolving first would have served it. The shape is
   refused outright.
3. Not absolute → `400`.
4. **Registry resolution is the containment barrier.** `path.resolve(raw)` must match a
   registered workflow exactly, or `404`. A caller cannot turn this route into an
   arbitrary-path manifest reader — the same barrier `src/server/actions.ts` relies on for
   `input-contract` and `deploy`.
5. Symlink escape: the agent directory is `realpath`'d, and `<dir>/sapiom.json` must resolve
   **inside** it (`resolveWithinRoot`). A symlinked agent *directory* is legitimate — the user
   registered it — but a `sapiom.json` symlinked out of the project would turn a path-keyed
   read endpoint into a file reader, so that is a `400`.

No second path-containment helper was added: this reuses `hasTraversalSegment` and
`resolveWithinRoot` from `src/core/path-safety.ts`.

## Tests

`src/server/workflow-graph.test.ts` — happy path, an agent with no session, real on-disk
`sapiom.json`, `404` unregistered, four `400` rejection shapes (including a traversal that
would have normalized onto a registered path), the `sapiom.json` symlink escape, a symlinked
agent directory that must still work, all three `empty` marker states, a vanished directory,
and `error`/`preparing` pass-through.
