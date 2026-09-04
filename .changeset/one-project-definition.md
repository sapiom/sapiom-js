---
"@sapiom/harness": patch
---

Fix Studio showing the retired agent-creation controls instead of the project's Agent Map. Launching the harness inside an agent's own folder made the sidebar draw a row for the folder that holds it, which the server had never registered, so the project's Agent Map could not be found and the older create menu came back. The sidebar and the server now decide what counts as a project the same way.

Existing installs need no migration. A project whose folder moves up to the folder holding it keeps its identity, so its Agent Map, its agents and its planning sessions come with it; where that move is ambiguous, because one folder holds several projects that all moved, a new project is created and nothing existing is altered.
