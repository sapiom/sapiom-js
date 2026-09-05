---
"@sapiom/harness": minor
---

Activate one recoverable first-session map bootstrap for newly opened Studio projects. Durable project intent, input receipts, readiness, preemption, and restart recovery share the ordinary session lifecycle.

Breaking changes for embedders and HTTP clients:

- Remove `HarnessSession.planning`, `SessionManager.setPlanningMetadata()`, and the trusted create/resume `planning` options. Read the neutral `agentMapIdentity` for project identity and optional `projectBootstrap` for lifecycle state. The server migrates valid persisted legacy metadata and input queues automatically.
- Remove the planner contracts `PlannerGreetingErrorCode`, `PlannerGreetingState`, `PlannerSessionMetadata`, `PlannerQueuedInput`, `PlannerSessionRequest`, `PlannerSessionResponse`, `PlannerMessageRequest`, `PlannerSessionMetadataResponse`, and `PlannerLifecycleEvent`. Use ordinary session request/response types and `ProjectBootstrapMetadata`, `ProjectBootstrapState`, and `ProjectBootstrapInputReceipt` for bootstrap state and input acknowledgements.
- Remove `POST /api/projects/:projectId/planner-sessions`, `POST /api/projects/:projectId/planner-sessions/:sessionId/messages`, and `POST /api/projects/:projectId/planner-sessions/:sessionId/greeting/retry`. Create, resume, and send input through `POST /api/sessions`, `POST /api/sessions/:id/resume`, and `POST /api/sessions/:id/input`. Bootstrap recovery is server-owned. Clients supplying the first prompt should set `initialUserInputPending: true` when creating a session.
- Replace the `planner_session.*` and `planner_greeting.*` analytics event names with `project_agent.identity_*` and `project_bootstrap.*`. Their remote projections remain content-free.

Project creation and root binding can return `202` with a committed project identity when automatic initialization must retry; treat that identity as successfully created. Settings updates return their committed values while new-root initialization continues in the background. Server shutdown keeps admission fenced and bounds its wait for bootstrap, persistence, archive, and telemetry drains before releasing the listener.
