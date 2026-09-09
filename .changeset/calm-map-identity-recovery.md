---
"@sapiom/harness": patch
---

Fix project selection when a current Studio server cannot resolve the project's identity: show "Agent Map unavailable" with a "Reload projects" retry instead of the legacy project graph, and no longer start or select a session when that project is clicked. Explicit session creation and session-tab navigation remain available. Reloading project identities preserves the selected project and active conversation, and current projects ignore obsolete graph events.
