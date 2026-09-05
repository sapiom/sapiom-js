---
"@sapiom/harness": patch
---

Activate one recoverable first-session map bootstrap for newly opened Studio projects. Durable project intent, input receipts, readiness, preemption, restart recovery, and shutdown now share the ordinary session lifecycle. Retire planner-session routes and metadata after migrating their persisted input queues; embedders should use the ordinary session create, resume, and input routes.
