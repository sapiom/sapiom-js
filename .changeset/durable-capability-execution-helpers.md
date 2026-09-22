---
"@sapiom/tools": minor
---

Add the opt-in `capabilityDelivery: "executions"` client setting and a reviewed
eligibility gate for common capability helpers. Eligible calls preserve their
existing result mapping while submitting once and waiting for the saved result;
interrupted or uncertain calls never fall back to another synchronous invocation.
The default remains `"legacy"`, and no production capability is eligible yet.

Search, content generation, and key helpers now honor the client's `coreBaseUrl`
when no per-call base URL is provided.
