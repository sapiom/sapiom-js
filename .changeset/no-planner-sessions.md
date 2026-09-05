---
"@sapiom/harness": minor
---

**Breaking.** Studio never creates a planner session. Selecting a project or its Plan Agents row shows the Agent Map from durable state and starts nothing; a project's first session is an ordinary session started explicitly, through the same createSession path as the + tab, and it has the Agent Map tools.

Migration:

- `HarnessSession.planning` is removed. Sessions persisted with planner metadata load and resume as ordinary sessions; the stale key is dropped on registry load and nothing on disk is deleted. Drop any read of `session.planning`.
- `POST /api/projects/:id/planner-sessions`, its `/messages` child and its `/greeting/retry` child now answer `410` with `planner_sessions_removed`.
- The eight `planner_session.*` and `planner_greeting.*` `AnalyticsEventType` members are no longer emitted. They stay in the union, deprecated, for one release so an exhaustive switch still compiles; they are removed in the next minor.

The planner greeting coordinator, the planning session service and the planner profile are deleted. The Agent Map store, its MCP tools and the renderer are unchanged.
