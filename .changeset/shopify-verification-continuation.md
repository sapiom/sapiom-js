---
"@sapiom/browser-pay": minor
---

Automatically observe supported Shopify merchant challenges on the existing browser, wait for the native completion callback and reconcile the same card-session receipt without repeating the checkout submission.

Refuse another checkout submission when durable verification state already records a captured or launched challenge.

Validate and bound the captured URL and single-field CReq form before reporting, preserve accepted protocol data exactly, and match the backend's 255-character card-session limit.

Validate the CReq encoding, padding and supported message schema before capture. If optional verification registration fails, keep the existing checkout relay path available without a verification observer.

Retain a separate Shopify submission fence when registration reports an observer mismatch. The interceptor stays attached for ordinary traffic and card relay, but cannot repeat Pay for the conflicted verification.
