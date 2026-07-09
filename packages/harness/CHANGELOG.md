# @sapiom/harness

## 0.1.0

### Minor Changes

- 020139a: Canvas serving, macro engine, and dev-server port detection — the backend half of the canvas/action-rail/preview workstream:

  - `GET /canvas/:harnessSessionId/*` serves whatever a session's agent wrote to its `.sapiom/canvas/` directory, with a friendly HTML empty-state when nothing's been rendered yet.
  - `GET /api/macros` / `POST /api/macros/:id/run` resolve and execute the action-rail macros (`{{workflow.path}}`-style placeholder substitution, missing-value validation).
  - Per-session canvas file watching (`canvas.reload` on change) and streaming `localhost:<port>` detection (`port.detected`) for the Preview pane's port chip.

### Patch Changes

- Updated dependencies [020139a]
- Updated dependencies [020139a]
- Updated dependencies [c0fef6d]
- Updated dependencies [3dfbd10]
  - @sapiom/agent@0.6.1
  - @sapiom/agent-core@0.8.0
  - @sapiom/mcp@0.10.0
