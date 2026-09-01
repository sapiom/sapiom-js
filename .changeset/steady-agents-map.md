---
"@sapiom/harness": minor
---

Open durable Studio projects in a pinned Agent Map workspace and remember the selected Agent Map or agent per user and project. Preferences live in the new `agent-map/studio-workspace-preferences.json` state file and are exposed through the path-free `GET` and `PUT /api/projects/:projectId/current-workspace` routes. Agent identities remain opaque outside the server, survive authenticated moves, and repair safely when a complete project scan proves that an agent was deleted.
