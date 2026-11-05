---
"@sapiom/browser-pay": minor
"@sapiom/core": minor
---

Add purchase-bound bank verification to the existing browser interceptor and relay credential
channel, plus typed purchase verification responses and bounded transaction reads. Browser
creation and ownership remain with the existing checkout integration.

Match the backend's whole-number `maxWaitSeconds` range of 0 to 25 and keep HTTP
deadlines active through response-body reads. Report body-read aborts as timeouts
without retrying. Skip polling timers for verification sessions that register in
a terminal state, and mark the adapter hook internal until U6 defines general
checkout integration.
