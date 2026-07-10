---
"@sapiom/analytics-core": patch
---

Clarify harness `seq` gap semantics in CONTRACT.md.

The per-session `seq` section now notes that for the harness specifically,
`seq` indexes the local capture stream; some locally-sequenced event kinds are
not forwarded remotely, so remote streams have expected gaps. Duplicates are
the anomaly signal, not gaps. Verified against production data 2026-07-09.
