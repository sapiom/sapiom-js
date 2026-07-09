---
"@sapiom/langchain": patch
"@sapiom/langchain-classic": patch
---

402 payment-retries no longer emit a separate error event; success carries payment_retried.

Previously, a pay-gated MCP tool call emitted two `tool.call` analytics events: an `error` event for the expected 402 bounce, then a `success` event for the paid retry. This doubled apparent error rates in dashboards.

**What changes:**
- The expected-402 bounce emits nothing at bounce time.
- The final outcome emits exactly ONE `tool.call` event per logical call.
- When a payment retry happened, the event carries `payment_retried: true` in `data` — friction stays visible as a field, never as a second event.
- If the retry also fails (payment succeeded but call failed), exactly one error event emits with `payment_retried: true`.
- Non-payment errors are unaffected: one error event, no `payment_retried` field.

Net invariant: one logical tool call = exactly one `tool.call` event, always.
