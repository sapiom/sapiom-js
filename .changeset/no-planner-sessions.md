---
"@sapiom/harness": minor
---

Studio never creates a planner session any more. Selecting a project or its Plan Agents row shows the Agent Map from durable state and starts nothing. A project's first session is an ordinary session started explicitly from the centre pane or the tab strip, through the same createSession path as the + tab, and it has the Agent Map tools. Sessions persisted with planner metadata resume as ordinary sessions. The planner routes (create, message, greeting retry) answer 410 with `planner_sessions_removed`. The planner greeting coordinator, planning session service, and planner profile are deleted.
