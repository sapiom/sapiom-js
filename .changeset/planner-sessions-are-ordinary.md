---
"@sapiom/harness": minor
---

The read-only Agent Map planning profile introduced in 0.13.0 is gone. A project's Plan Agents session is now an ordinary Studio session that also has the Agent Map tools: it runs on the served authoring prompt with the map context appended, so it can scaffold, edit, run, and deploy agents when asked. Anyone who relied on that session refusing to implement should know it no longer does. The SessionStart orientation and the greeting copy now say the session plans and builds.
