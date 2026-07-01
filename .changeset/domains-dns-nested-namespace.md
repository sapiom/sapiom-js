---
"@sapiom/tools": patch
---

Expose the nested `dns` namespace on the `domains` capability so `domains.dns.*` (create, list, get, update, delete) works when the `domains` namespace is imported directly, matching the client and the documented `@example`s.
