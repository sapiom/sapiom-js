---
"@sapiom/tools": minor
---

Add `client.executions.wait` and `executions.wait` to retrieve durable capability
results with bounded polling, retry backoff, and abort support. Resume a saved
execution handle in a fresh process without submitting another request. A local
timeout or abort stops waiting while the accepted execution continues; failed,
expired, and indeterminate outcomes remain distinct typed errors.
