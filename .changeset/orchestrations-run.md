---
"@sapiom/tools": minor
---

Add the `orchestrations` capability — run a deployed orchestration by slug, or dispatch one from a workflow step and pause on its result.

```ts
import { orchestrations } from "@sapiom/tools";

// run inline:
const result = await orchestrations.run({ definition: "enrich-lead", input });

// or dispatch from a step and resume when it finishes:
const child = await orchestrations.launch({ definition: "enrich-lead", input });
return pauseUntilSignal(child, { resumeStep: "use-result" });
```

`launch` returns a handle usable with `pauseUntilSignal`; the resumed step receives an `OrchestrationRunResultPayload` (validate with `orchestrationResultSchema`). Also exports `ORCHESTRATIONS_RESULT_SIGNAL` for the static `pause` declaration on a step.
