---
"@sapiom/browser-pay": minor
---

Add `@sapiom/browser-pay`. It pauses a held placeholder over CDP and posts David's relay body to `POST /v1/transactions/{id}/payment/relay`. The idempotency key is sha256 of method, URL, and body.
