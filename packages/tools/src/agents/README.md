# agents

Run a deployed agent and await its result — or, from inside a step, dispatch one and pause until it finishes. An agent is addressed by its **slug** (its stable handle).

```ts
import { agents } from "@sapiom/tools";

// Standalone: run a deployed agent and wait for its result.
const result = await agents.run({ definition: "enrich-lead", input: { id } });
if (result.status === "completed") {
  // result.output
}
```

From inside a step, dispatch another agent and suspend until it finishes — the step you name in `resumeStep` receives the typed result as its input:

```ts
import { agents } from "@sapiom/tools";
import { defineStep, fail, pauseUntilSignal } from "@sapiom/agent";

const enrich = defineStep({
  name: "enrich",
  pause: { signal: agents.AGENTS_RESULT_SIGNAL, resumeStep: "use-result" },
  canFail: true,
  async run(input, ctx) {
    const child = await agents.launch({ definition: "enrich-lead", input });
    // A refused dispatch (unknown slug, input the engine rejected, transport
    // fault) produced no child, so there is nothing to pause on.
    if (child.rejection) {
      return fail(`enrich-lead dispatch rejected: ${child.rejection.message}`);
    }
    return pauseUntilSignal(child, { resumeStep: "use-result" });
  },
});

const useResult = defineStep({
  name: "use-result",
  terminal: true,
  async run(result: agents.AgentRunResultPayload, ctx) {
    if (result.status === "failed") {
      // result.error — failure is data you branch on, not a thrown exception
    }
    // result.output (when completed)
  },
});
```

## Things to know

- **`run` blocks; `launch` returns a pausable handle.** `run` polls until the run reaches a terminal state and returns its result — use it for standalone, inline calls. `launch` returns immediately with a handle you hand to `pauseUntilSignal(handle, { resumeStep })` to suspend the step until the run finishes. Don't use `run` to pause a step — it returns a result, not a handle.

- **Failure is data, not an exception — including a rejected dispatch.** Branch on `status`; `if (result.status !== "completed")` is the only check you need. `run` resolves on every outcome and never throws:

  | `status`      | What happened                                                                                                                                                                                    |
  | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `"completed"` | The run finished; read `output`.                                                                                                                                                                 |
  | `"failed"`    | The run itself failed; `error` is what the child reported.                                                                                                                                       |
  | `"cancelled"` | The run was cancelled.                                                                                                                                                                           |
  | `"rejected"`  | The **dispatch** was refused, so no run was ever created — unknown slug, `input` the engine's pre-gate refused, or a transport fault. `executionId` is `null` and `error` is an `AgentRunError`. |
  | `"timed_out"` | `wait` hit its `timeoutMs` while the run was still going. `executionId` is set, so you can check on it later.                                                                                    |

  On `"rejected"`/`"timed_out"`, `error` is an `AgentRunError`: `{ code, message, status, details }`. `code` is the coarse bucket (`"not_found"` for an unknown slug, `"invalid_input"` for refused input, `"http"`, `"transport"`, `"timeout"`), and `details` keeps the platform's own response body — its stable code and any validation issues. Validate an incoming resume payload with `agents.agentResultSchema.parse(value)` if you want a runtime check.

- **A rejected `launch` isn't pausable.** `launch` doesn't throw either, but a dispatch that was refused produced no child, so nothing can ever fire the resume signal. That handle carries no `dispatch` and exposes the rejection as `handle.rejection` instead — check it before pausing, as the example above does. Pausing on it anyway throws from `pauseUntilSignal` rather than parking the step on a signal that never arrives.

- **Addressed by slug.** `definition` is the deployed agent's slug — its stable handle. `input` is passed to its entry step.

- **`idempotencyKey` deduplicates.** Repeating a launch with the same key returns the existing run instead of starting a new one.

- **Delayed dispatch (`at`).** `launch({ definition, input, at })` schedules the child to run at a future time (`at` is a `Date` or ISO 8601 string) instead of now, and returns a **pause-only** handle: hand it to `pauseUntilSignal` and the step resumes with the child's result once the scheduled run finishes. `status`/`wait` aren't available on a delayed handle (there's no run until then), so use `launch` + `pauseUntilSignal`, not `run` — this is the one place the no-throw contract doesn't reach: a refused delayed launch still resolves a rejected handle, but calling `status`/`wait` (and so `run`) on a SUCCESSFUL one throws, as it always has. For a plain fire-and-forget one-off (no resume), use the `schedules` capability instead.
