---
"@sapiom/opencode": patch
---

Tolerate Linux processes exiting while their status is read during native shutdown,
while preserving cleanup failures for unreadable or unverified tracked processes.
