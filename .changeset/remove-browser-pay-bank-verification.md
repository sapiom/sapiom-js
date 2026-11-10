---
"@sapiom/browser-pay": minor
---

Remove managed bank verification. `attachInterceptor` no longer registers a verification observer with the backend before a Shopify checkout, so attaching makes no extra request. `handle.verification`, the `verificationAdapter` option, the relay's `verification` transport and the `VerificationState`, `VerificationHandle` and `VerificationAdapterFactory` types are removed. The capability was never enabled, so `handle.verification` was always absent. A bank prompt stays in the checkout browser for the agent and the buyer to handle.
