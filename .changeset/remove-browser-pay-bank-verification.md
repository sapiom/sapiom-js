---
"@sapiom/browser-pay": minor
---

Remove managed bank verification. `attachInterceptor` no longer registers a verification observer with the backend before a Shopify checkout, so attaching makes no extra request. `handle.verification`, the `verificationAdapter` option, the relay's `verification` transport and the `VerificationState`, `VerificationHandle` and `VerificationAdapterFactory` types are removed. Sapiom's backend never enabled the capability, so `handle.verification` was always absent with `httpPaymentRelay` or any relay that forwards to Sapiom. A custom `PaymentRelay` that supplied its own `verification` transport should drop it: the interceptor no longer reads it. A bank prompt stays in the checkout browser for the agent and the buyer to handle.
