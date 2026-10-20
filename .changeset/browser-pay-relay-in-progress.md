---
"@sapiom/browser-pay": patch
---

Hold a paused card request and post the same idempotency key again when the relay returns `relay_in_progress`, until the outcome is terminal or the relay deadline passes.
