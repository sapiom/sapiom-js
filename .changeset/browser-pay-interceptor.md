---
"@sapiom/browser-pay": minor
---

Add `@sapiom/browser-pay`. It pauses a held placeholder card over CDP and posts the T7 body to `POST /v1/transactions/{id}/payment/relay`. Matching is a Luhn gate plus the exact number anywhere in the raw body. The idempotency key is sha256 of method, URL, and body.
