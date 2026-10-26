---
"@sapiom/browser-pay": patch
---

`failed` events with reason `intercept_unavailable` include the CDP method, numeric error code, timeout flag, target type, and origin. The target is still closed. A nested `Target.setAutoAttach` failure, and a `Target.attachToTarget` failure on an iframe that would have been armed, now close that target too. Captcha widgets, extension pages, and workers stay open. Remote error text is not included.
