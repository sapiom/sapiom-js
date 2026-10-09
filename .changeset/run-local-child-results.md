---
"@sapiom/mcp": patch
"@sapiom/agent-core": patch
---

`run_local`: the tool description now states that a step paused on an `agents.launch`, `models.launch` or `models.coding.launch` handle resumes locally with that call's stubbed result (for `agents.launch`, the child's `AgentRunResultPayload`), and that only a pause on a signal no stubbed launch produced (a webhook, an approval) resumes with `{}`. It previously named only `models.coding.launch`, so authors of parent/child agents assumed the child result could not be exercised locally. `@sapiom/agent-core` adds regression tests for the `agents.launch` and `models.launch` resume paths; runtime behaviour is unchanged.
