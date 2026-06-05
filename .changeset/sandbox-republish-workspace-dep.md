---
"@sapiom/sandbox": patch
---

Republish to fix the `@sapiom/fetch` dependency. The `0.8.1` artifact shipped with the unresolved `workspace:*` specifier, making it uninstallable; this release ships it resolved to a real version range.
