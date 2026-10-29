---
"@sapiom/browser-pay": patch
---

Accept HTTP(S) CDP discovery endpoints in addition to WebSocket URLs. Resolve
the browser WebSocket through `/json/version`, preserving provider path and
query parameters, with bounded discovery time and response size. Reject
redirects and HTTPS-to-insecure-WebSocket downgrades without exposing endpoint
credentials in errors.
