---
"@sapiom/analytics-core": patch
---

All emitter instances now share a single `process.on("beforeExit")` listener (module-level registry) instead of registering one each. Consumers constructing many short-lived emitters no longer accumulate listeners toward `MaxListenersExceededWarning`; the shared listener detaches when the last instance shuts down, so listener counts return to baseline. No API change; flush-on-exit and process-lifetime semantics are unchanged.
