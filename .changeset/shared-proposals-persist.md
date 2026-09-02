---
"@sapiom/harness": minor
---

Prepare crash-atomic, project-wide Agent Map proposal persistence for the SAP-3060 transport, with attributed operation history, bounded session-scoped idempotency receipts, and history-derived stale-write rebasing. Exact results are retained for a bounded retry window, while older same-session request IDs cannot apply twice. Agent Map workspace reads now return a coherent versioned workspace-and-proposal snapshot, and the named browser-safe contracts required by the accepted-delta bus payload are exported from the package entry point.
