---
"@sapiom/browser-pay": minor
---

Interceptor event URLs now expose only the request origin, and refusal reasons are restricted to known relay values (exported as the `RefusalReason` type). CDP attach errors use fixed messages to avoid forwarding transport details.
