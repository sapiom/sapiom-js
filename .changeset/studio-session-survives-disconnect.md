---
"@sapiom/harness": patch
---

Keep resumable sessions available after account disconnect by restarting them without credentials. Resume also re-derives the current Studio project scope instead of relying on stale session metadata.
