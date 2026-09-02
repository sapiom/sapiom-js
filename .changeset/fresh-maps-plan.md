---
"@sapiom/harness": minor
---

Open Studio Agent Maps as a dedicated planning workspace with a live, project-scoped planning conversation beside the durable map. Planner tabs can resume, start fresh, rename, and end; transcript updates refetch through content-free invalidations, map and planner failures retry independently, and mobile keeps the conversation primary behind an explicit Agent Map sheet.

This release adds variants to the public `BusMessage`, `UiEventName`, and `AnalyticsEventType` unions. Consumers that switch over these forward-extensible event types should retain a default arm so later additive events remain source-compatible.
