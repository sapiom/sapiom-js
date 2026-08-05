---
"@sapiom/tools": patch
---

Align the `llm` capability's JSDoc label examples with the public Router
taxonomy (`smart`, `small`, `medium`, `large`).

The previous examples referenced model-name labels — `m2.7` (no longer a
routable `/v2` label; copying that example now yields a `400`), `minimax-m3`,
`sonnet`, `haiku`. The user-facing contract for the Router is the smart /
size-tier label set, so the docstrings and inline examples now show those.
No runtime behavior change: `model` / `label` remain free-form strings
validated by the gateway.
