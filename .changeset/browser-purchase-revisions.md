---
"@sapiom/core": minor
"@sapiom/fetch": patch
"@sapiom/axios": patch
"@sapiom/node-http": patch
"@sapiom/mcp": patch
---

Add versioned browser purchase updates with stable idempotency keys. Polling returns `needs_revision` with actionable reasons, and HTTP adapters block that policy decision even in failureMode open. Updates require the backend browser revision release and do not edit the merchant's cart.

HTTP adapters stop on either the revision status or the revise action, including Fetch's on-demand transaction creation after an HTTP 402, before further authorization or retry.
