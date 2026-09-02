---
"@sapiom/harness": minor
---

Persist one crash-atomic, project-wide Agent Map proposal with attributed operation history, bounded session-scoped idempotency receipts, and history-derived stale-write rebasing. Exact results are replayed for the latest 256 accepted batches; older same-session request IDs remain history tombstones and fail closed instead of applying twice. Agent Map workspace reads now return a coherent versioned workspace-and-proposal snapshot, and the browser-safe Agent Map contracts (including the accepted-delta bus payload) are exported from the package entry point. Proposal writes remain transport-neutral until the MCP transport lands in SAP-3060.
