---
"@sapiom/harness": minor
---

A canvas board can now be read by agent path, with no session involved: `GET /api/workflows/:path/graph`.

The canvas was reachable only at `/canvas/:harnessSessionId/`, resolved by the session's current binding — so an agent that had never hosted a session had no board, and you could not look at agent F's board while working in agent B's session.

This adds a second, session-free entry point onto the *same* derivation. `deriveWorkflowCanvas` is extracted out of the render-file write path and shared by both, so the document this route returns is byte-identical to the render a bound session's canvas serves for the same workflow. Nothing is written to disk.

`:path` is the agent's absolute directory, URI-encoded into one segment (`encodeURIComponent(agentPath)`), matching `/api/workflows/:id/input-contract`. It sits behind the usual `/api` boot-token middleware, so it is a `fetch` target rather than an `<iframe src>`.

Failure modes are deliberately distinct: `400` for a blank, relative or `..`-carrying path (and for a `sapiom.json` symlinked out of the project), `404` only for a path that is not a registered workflow, and `200` with `status: "empty" | "preparing" | "error" | "ok"` for everything else — a missing `sapiom.json` is an empty board, never a missing route.

Full contract: `packages/harness/docs/agent-canvas-graph.md`.
