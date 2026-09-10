---
"@sapiom/harness": patch
---

Prevent repeated exit-status broadcasts from deleting configuration regenerated during session resume, including sessions restored after restart or imported from history. Failed resume preparation also cleans up regenerated configuration.
