---
"@sapiom/harness": patch
---

Adapt direct source invocations into package-scoped graph evidence with
content-based freshness, opaque callsite references, conservative coverage,
and last-good replacement semantics while preserving the existing System Graph
edge and warning payloads. Dynamic targets now make invocation coverage partial,
so affected graph snapshots are explicitly degraded/retryable instead of being
cached as complete.
