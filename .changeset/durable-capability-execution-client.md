---
"@sapiom/tools": minor
---

Add `client.executions.prepare`, `submit`, and `get`, also available through
`@sapiom/tools/executions`, for durable capability requests. Save a prepared
descriptor before submission to retain the request, idempotency key, and Core
origin when a response is lost. Requests have bounded timeouts, strict response
validation, typed errors, and origin checks when restoring saved descriptors.

Existing capability methods continue to use their current delivery behavior.
