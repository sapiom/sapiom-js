---
"@sapiom/node-http": patch
---

`createClient`'s request handler could report a stale "Payment required" (402) error to `transactions.complete()` when the *payment-handling* itself failed (a reauthorize API error, timeout, or a failed retry) — the `error = null` line meant to clear the original 402 was only reached on success, so a throw from `handlePayment` left `error` pointing at the original 402 instead of the actual failure. Matches `@sapiom/fetch`'s equivalent flow, where `handlePayment` runs inside the same `try` as the initial request so its own throw is captured correctly.
