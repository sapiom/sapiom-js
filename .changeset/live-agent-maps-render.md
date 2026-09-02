---
"@sapiom/harness": minor
---

Render the shared Agent Map proposal live beside its raw coding-agent CLI. Studio now applies only contiguous attributed deltas, refetches durable state after gaps or reconnects, and presents all five planned node kinds and six directed relationship kinds on a read-only accessible canvas with structured inspection and one role-neutral Proposed treatment.

Planner onboarding now stays in the coding agent's hidden launch context instead of appearing as a synthetic user turn, and signed-out local sessions rooted in a Studio project receive the same scoped Agent Map tools as authenticated sessions. The former automatic assistant-first greeting and retry lifecycle is now compatibility-only for persisted sessions and API clients; new interactive planner sessions begin with the developer's real input, so `planner_greeting.attempted`, `planner_greeting.delivered`, `planner_greeting.failed`, `planner_greeting.skipped`, and `planner_greeting.retried` should no longer be treated as active new-session signals.

This release adds variants to the public `UiEventName` and `AnalyticsEventType` unions. Consumers that switch over these forward-extensible event types should retain a default arm so later additive events remain source-compatible.
