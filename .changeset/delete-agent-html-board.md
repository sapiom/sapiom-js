---
"@sapiom/harness": minor
---

An agent's Canvas now matches the project map. It shows the agent's steps at the version the map is drawing, and every agent it calls or that calls it as a card at the edge of the board. A call's line starts at the step that makes it when the code shows which step does. Agents without a `sapiom.json` now get a Canvas too.

Removed:

- the per-agent board files under `.sapiom/canvas/renders/`;
- the session board at `/canvas/:sessionId/`;
- the server render that wrote them.

The Canvas is computed when you open it and reads again when the project's code changes. Existing `.sapiom/canvas/` folders in your projects can be deleted.
