---
"@sapiom/harness": minor
---

Canvas serving, macro engine, and dev-server port detection — the backend half of the canvas/action-rail/preview workstream:

- `GET /canvas/:harnessSessionId/*` serves whatever a session's agent wrote to its `.sapiom/canvas/` directory, with a friendly HTML empty-state when nothing's been rendered yet.
- `GET /api/macros` / `POST /api/macros/:id/run` resolve and execute the action-rail macros (`{{workflow.path}}`-style placeholder substitution, missing-value validation).
- Per-session canvas file watching (`canvas.reload` on change) and streaming `localhost:<port>` detection (`port.detected`) for the Preview pane's port chip.
