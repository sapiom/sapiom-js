# orchestrations

Run a deployed orchestration and await its result — or, from inside a step, dispatch one and pause until it finishes. An orchestration is addressed by its **slug** (its stable handle).

```ts
import { orchestrations } from "@sapiom/tools";

// Standalone: run a deployed orchestration and wait for its result.
const result = await orchestrations.run({ definition: "enrich-lead", input: { id } });
if (result.status === "completed") {
  // result.output
}
```

From inside a step, dispatch another orchestration and suspend until it finishes — the step you name in `resumeStep` receives the typed result as its input:

```ts
import { orchestrations } from "@sapiom/tools";
import { defineStep, pauseUntilSignal } from "@sapiom/agent";

const enrich = defineStep({
  name: "enrich",
  pause: { signal: orchestrations.ORCHESTRATIONS_RESULT_SIGNAL, resumeStep: "use-result" },
  async run(input, ctx) {
    const child = await orchestrations.launch({ definition: "enrich-lead", input });
    return pauseUntilSignal(child, { resumeStep: "use-result" });
  },
});

const useResult = defineStep({
  name: "use-result",
  terminal: true,
  async run(result: orchestrations.OrchestrationRunResultPayload, ctx) {
    if (result.status === "failed") {
      // result.error — failure is data you branch on, not a thrown exception
    }
    // result.output (when completed)
  },
});
```

## Things to know

- **`run` blocks; `launch` returns a pausable handle.** `run` polls until the run reaches a terminal state and returns its result — use it for standalone, inline calls. `launch` returns immediately with a handle you hand to `pauseUntilSignal(handle, { resumeStep })` to suspend the step until the run finishes. Don't use `run` to pause a step — it returns a result, not a handle.

- **Failure is data, not an exception.** The result is discriminated on `status` (`"completed" | "failed"`). A failed run resumes your step with `status: "failed"` and an `error` to branch on — it does not throw. Validate an incoming payload with `orchestrations.orchestrationResultSchema.parse(value)` if you want a runtime check.

- **Addressed by slug.** `definition` is the deployed orchestration's slug — its stable handle. `input` is passed to its entry step.

- **`idempotencyKey` deduplicates.** Repeating a launch with the same key returns the existing run instead of starting a new one.

- **Delayed dispatch (`at`).** `launch({ definition, input, at })` schedules the child to run at a future time (`at` is a `Date` or ISO 8601 string) instead of now, and returns a **pause-only** handle: hand it to `pauseUntilSignal` and the step resumes with the child's result once the scheduled run finishes. `status`/`wait` aren't available on a delayed handle (there's no run until then), so use `launch` + `pauseUntilSignal`, not `run`. For a plain fire-and-forget one-off (no resume), use the `schedules` capability instead.
