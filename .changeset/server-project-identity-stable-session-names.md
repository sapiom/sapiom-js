---
"@sapiom/agent-map": patch
"@sapiom/harness": patch
---

Agent Studio: the server now issues a project identity for every published workspace scope and every session. `WorkspaceScopeSummary.projectId` is required (`unassignedScopes` is gone; unsafe or unresolvable roots are omitted rather than published project-less), `HarnessSession.agentMapIdentity` is required, and persisted sessions without one are migrated on load to the deepest open root that contains their folder — or dropped when no project can own them. Default session titles ("acme-app", "acme-app 2", …) are assigned once at creation and persisted, so ending a sibling session no longer renames the others.
