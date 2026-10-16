---
"@sapiom/browser-pay": minor
---

Add `@sapiom/browser-pay`, the browser-side payment interceptor. It attaches over CDP, pauses a request whose body carries the held placeholder card, and relays that request without ever continuing a placeholder to the payment provider.
