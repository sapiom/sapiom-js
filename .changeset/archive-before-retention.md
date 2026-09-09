---
"@sapiom/harness": patch
---

Limit archive backfill to 200 conversations per maintenance pass. Keep source events while work remains or archiving fails, and retry at the next scheduled cleanup.
