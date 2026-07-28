---
"@sapiom/harness": minor
---

Canvas board redesign + deterministic step/workflow metadata.

- **Board redesign** matching the new design: in-drawer step navigation removed (the chart is beside it), chat split into a standalone toggleable panel independent of the info panel, the board subheader dropped with the deployed pill and expand relocated to the tab bar, and the manual "Render diagram" button replaced by auto-render on bind/session-start.
- **Deterministic metadata:** the renderer surfaces per-step `description` / `inputSchema` / `capabilities` / `timeoutMs` and a workflow Overview payload, all read from the manifest (no LLM in the render path). When a step doesn't call a capability or declare a description, the field is simply absent — the shape summary still renders.
- **Capability auto-detect** from `sapiom.*` call sites in the workflow source, attributed to the `defineStep` block the call sits in (calls in shared helpers are left unattributed rather than mis-billed to the nearest step).

Reads the new optional `description` / `capabilities` fields from `@sapiom/agent`; workflows on an older SDK render with those fields blank.
