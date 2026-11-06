---
"@sapiom/browser-pay": patch
---

Reject the original native verification promise at its validation deadline so late responses cannot fulfill it. Emit the private delivery receipt before the merchant's promise continuation can navigate, preserving one-use native return acknowledgment.
