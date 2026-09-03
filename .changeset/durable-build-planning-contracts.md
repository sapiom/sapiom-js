---
"@sapiom/harness": minor
---

Add durable, exact-source build-plan, focused-brief, planning-assignment, and builder-submission contracts with strict codecs, canonical digests, validation, and crash-atomic project history.

Expose a deliberate, transitively usable v1 handoff surface for hosts and downstream E4/E5 integrations.

Agent Map workspace files are migrated from aggregate storage schema v1 to v2 in place. The migration preserves existing architecture proposal history and receipts, but it is intentionally downgrade-incompatible: older `@sapiom/harness` versions cannot read a workspace after the v2 aggregate has been written.
