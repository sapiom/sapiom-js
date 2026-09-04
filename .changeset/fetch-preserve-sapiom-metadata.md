---
"@sapiom/fetch": patch
---

Preserve `Request.__sapiom` metadata across internal Request cloning so per-request `enabled: false` overrides work when the input is a Request object.
