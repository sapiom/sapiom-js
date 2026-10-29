---
"@sapiom/core": minor
"@sapiom/tools": patch
---

The SDK sends request idempotency keys as `Idempotency-Key`, the API's one idempotency header, instead of `X-Idempotency-Key`. `HttpClient` still treats a key you pass under either spelling as the request's key and never adds a second one; browser automation sends its key once instead of under both names. The API accepts `X-Idempotency-Key` with the same meaning, so code that sets it keeps working.
