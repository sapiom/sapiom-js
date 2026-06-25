---
"@sapiom/mcp": patch
---

Fix `sapiom_dev_orchestrations_run` rejecting valid input as "input must be an object".

The real-run tool passed the `input` argument straight through, but some MCP clients serialize object-valued args as a JSON string — so the execution API (which requires an object) received `"{}"` and returned HTTP 400. `run_local` already normalized this with `coerceJson`; the real-run path now does the same and defaults an absent input to `{}`. Brings the two paths into parity.
