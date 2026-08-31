---
"@sapiom/tools": minor
---

Add a private v1 runtime-provenance carrier for agent invocations. Instrumented
calls send opaque callsite evidence out of band, terminal results retain an
SDK-only server receipt, and only exact direct result-to-input handoffs forward
that receipt. Request/result JSON and calls without metadata remain unchanged.
