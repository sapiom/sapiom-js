---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
"@sapiom/mcp": patch
---

Studio's agent map now shows Jev's role and edge labels, as `sapiom_dev_map` does: cached per project and shown only at p ≥ 0.8. Edges from different agents no longer merge into one shared line, so each line shows who calls whom. `accountEvaluate` is exported from `@sapiom/mcp/map`.
