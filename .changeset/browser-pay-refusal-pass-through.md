---
"@sapiom/browser-pay": minor
---

A refused event may include optional `retryable` and `requestId`. When `retryable` is missing, the event leaves it unset. The SDK does not invent it, and polling still follows only `relay_in_progress`.

A reason on that event passes through when it matches `/^[a-z]+(_[a-z]+)*$/` and is at most 48 characters, including a reason this package does not list. Every other reason is `unrecognized`. `RefusalReason` is that open set. `KnownRefusalReason` names the reasons the relay emits today.
