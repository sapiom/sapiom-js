---
"@sapiom/browser-pay": patch
---

`failed` events with reason `intercept_unavailable` include the CDP method, integer error code, timeout flag, target type, and origin. The target is still closed. Remote error text is not included. An optional `logger` receives these swallowed steps, and CDP errors name the method.
