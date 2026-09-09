---
"@sapiom/harness": patch
---

Archive all historical conversation batches before event retention removes their source events. Keep source events if archiving fails, and retry at the next scheduled cleanup.
