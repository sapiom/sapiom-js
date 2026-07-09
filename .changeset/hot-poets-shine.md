---
"@sapiom/analytics-core": minor
---

Analytics delivery is now on by default to the hosted collector (the ship-dark default flipped live): with no `endpoint` configured, `createAnalytics` delivers to `SAPIOM_COLLECTOR_ENDPOINT`. Opt-outs unchanged (`SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, programmatic `disabled: true`) — any of them still makes the emitter a complete no-op: zero network calls, zero disk writes.
