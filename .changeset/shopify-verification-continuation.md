---
"@sapiom/browser-pay": minor
---

Automatically observe supported Shopify merchant challenges on the existing browser, wait for the native completion callback and reconcile the same card-session receipt without repeating the checkout submission.

Refuse another checkout submission when durable verification state already records a captured or launched challenge.

Validate and bound the captured URL and single-field CReq form before reporting, preserve accepted protocol data exactly, and match the backend's 255-character card-session limit.

Validate the CReq encoding, padding and supported message schema before capture. If optional verification registration fails, keep the existing checkout relay path available without a verification observer.

Follow the human review's registration fallback policy for every error, including observer mismatches. With no optional observer, the interceptor preserves native Shopify submissions without blocking other merchant tabs. A registered observer retains its capture and takeover fences; the SDK never initiates another Pay to resolve uncertainty.

Resolve challenge ancestry across browser sessions and support the verified current Shopify receipt query alongside the prior version. Before managed capture, unsupported checkout shapes and definite capture refusals preserve the native browser flow. Ambiguous reports retain the capture fence even when a later retry is refused.

Bind the native callback to the tracked checkout and cancel oversized callback/receipt response streams before buffering their complete bodies.

Allow the tracked checkout to navigate within its merchant origin before opening its callback, and leave definite backend termination before capture to the native checkout.

Keep subsequent bank requests native when polling has already ended an uncaptured observation. Captured or launched challenges and ambiguous in-flight capture reports retain their submission fences.
