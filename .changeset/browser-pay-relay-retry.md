---
"@sapiom/browser-pay": patch
---

Retry a paused card relay on attempt timeout, transport failure, and router HTTP 502, 503, or 504, using the same idempotency key, until the total deadline. One attempt defaults to 25 seconds. The total wait defaults to 55 seconds.
