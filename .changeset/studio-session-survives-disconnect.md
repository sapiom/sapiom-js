---
"@sapiom/harness": patch
---

Keep resumable sessions available after account disconnect by restarting them without credentials. Studio sessions and projects no longer depend on the signed-in account: resume uses the session's saved project, and switching or disconnecting accounts no longer invalidates sessions, project setup, Agent Map access, or workspace selections.
