---
"@sapiom/tools": patch
"@sapiom/agent-core": patch
---

run_local stub client documents and guards memory/database/email/domains availability: missing top-level capabilities throw `CapabilityNotAvailableError` instead of an opaque TypeError (#155).
