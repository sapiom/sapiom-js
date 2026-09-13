---
"@sapiom/harness": patch
---

Validate native session and message identifiers before creating Assistant continuation records or lock files. Reject malformed identifiers at the storage boundary while preserving the existing record names and protection against dispatching recovery twice.
