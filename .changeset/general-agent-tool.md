---
"@sapiom/tools": patch
---

Add the general `agent` capability — an instant, in-server agent (prompt → text), optionally calling tools on remote MCP servers. No sandbox.

```ts
import { agent } from "@sapiom/tools";

// run inline:
const res = await agent.run({ prompt: "Summarize this transcript: …" });
console.log(res.output);

// or dispatch from a workflow step and resume when it finishes:
const handle = await agent.launch({ prompt: "…", mcps: [{ /* … */ }] });
return pauseUntilSignal(handle, { resumeStep: "use-result" });
```

`run` resolves to an `AgentRunResult` (`output` carries the final text); `launch` returns a handle usable with `pauseUntilSignal`. Also exports `AGENT_RUN_RESULT_SIGNAL` for the static `pause` declaration on a step. This sits alongside the existing `agent.coding` capability.
