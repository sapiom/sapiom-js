---
"@sapiom/analytics-core": patch
---

Document session telemetry conventions and canonical event naming.

CONTRACT.md gains a "Harness & session telemetry conventions" section — per-session `data.seq` ordering, the `data.context` batch-context shape (`app_version`/`os`/`arch`/`node`), harness/agent session dimensions, and dot-separated `<noun>.<verb/state>` event naming — and the event taxonomy seed now uses the dot-form names (`session.start`, `capability.call`, `command.run`, ...). The `orchestration` producer source is renamed to `agent` in the contract and the `EventSource` type, matching the package family's rename — done before any events exist, and the collector accepts any source string verbatim regardless. Existing event names likewise remain valid: the collector keeps storing `event_type` verbatim.
