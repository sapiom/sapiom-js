---
"@sapiom/harness": minor
---

Discover markerless `defineAgent` and legacy `defineOrchestration` projects plus literal direct source invocations with bounded syntax-only analysis, conservative reconciliation, and live rail/system-graph updates without importing, bundling, type-checking, or executing project code. Public direct invocation edges use `basis: "static-invocation"`. Markerless agents inside nested Git repositories are discovered when that repository is selected directly; package-wide output-to-input data flow remains a separate evidence provider.

**Breaking:** Public system-graph invocation edges that previously carried `basis: "static"` now carry `basis: "static-invocation"`.

**Migration:** Consumers that validate or deserialize `GET /api/workspaces/:workspaceKey/system-graph` responses must accept `"static-invocation"` as the invocation-edge `basis` value before upgrading.
