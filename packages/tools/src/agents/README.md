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
    try {
      const child = await agents.launch({ definition: "enrich-lead", input });
      return pauseUntilSignal(child, { resumeStep: "use-result" });
    } catch (error) {
      // A refused dispatch (unknown slug, input the engine rejected, transport
      // fault) produced no child, so there was no handle to pause on.
      if (error instanceof agents.AgentDispatchError) {
        return fail(`enrich-lead dispatch rejected: ${error.message}`);
      }
      throw error;
    }
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

- **`run` reports failure as data; `launch` throws.** They return different kinds of thing, so a refused dispatch reaches you differently. `run` returns a result already discriminated on `status`, so `if (result.status !== "completed")` is the only check it needs — no try/catch, whatever went wrong:

  | `status`      | What happened                                                                                                                                                                                                                                                                           | `executionId` |
  | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
  | `"completed"` | The run finished; read `output`.                                                                                                                                                                                                                                                        | set           |
  | `"failed"`    | The run itself failed; `error` is what the child reported.                                                                                                                                                                                                                              | set           |
  | `"cancelled"` | The run was cancelled.                                                                                                                                                                                                                                                                  | set           |
  | `"rejected"`  | The dispatch was refused in a way that **proves no run was created** — unknown slug (404), `input` the engine's pre-gate refused (400/422), a declined credential (401/403).                                                                                                            | `null`        |
  | `"unknown"`   | **A child may exist and may still be running.** Either the run was created and its status couldn't be read (`executionId` set), or the dispatch itself was ambiguous — a 5xx, or a response lost after the platform accepted the request (`executionId` `null`, since no id came back). | see left      |
  | `"timed_out"` | `wait` hit its `timeoutMs` while the run was still going.                                                                                                                                                                                                                               | set           |

  On `"rejected"`, `"unknown"` and `"timed_out"`, `error` is an `AgentRunError`: `{ code, message, status, details }`. `code` is the coarse bucket (`"not_found"` for an unknown slug or a missing run, `"invalid_input"` for refused input, `"http"`, `"transport"`, and `"timeout"` — which pairs only with `"timed_out"`), and `details` keeps the platform's own response body, so its stable code and any validation issues survive.

- **`launch` throws `AgentDispatchError` on a refused dispatch.** It owes you a _pausable handle_, and a dispatch that created no child has none — an object with a null `executionId` that can't be paused on would be lying about what it is. So catch it and `fail()` the step, as the example above does. Every handle `launch` does return is pausable. `error.toRunError()` gives you the same `AgentRunError` `run` would have reported, if you want one shape across both call styles.

  Uncaught, it's an ordinary step throw, so the engine retries it up to `maxAttemptsPerStep` before failing the run. A refused dispatch is deterministic and won't self-heal, so catch it rather than letting the retry cap burn.

  The error's **`childMayExist`** draws the same distinction the `"rejected"` / `"unknown"` split draws for `run`: `false` when the platform proved it created nothing, `true` when the outcome was ambiguous (a 5xx, or a lost response). Retry only on `false`, or with an `idempotencyKey`.

- **Only `"rejected"` is safe to re-dispatch.** It is the one outcome that guarantees nothing is running, and it is deliberately narrow: a refusal only counts when the platform's answer proves it created nothing. A lost response or a 5xx does **not** prove that — the platform may have accepted the request and created the child before the response went missing — so those resolve `"unknown"`, not `"rejected"`.

  `"unknown"` and `"timed_out"` both name a child that may still be working. Re-running the slug there gives you two copies; pass an `idempotencyKey` if you retry on them. On an `"unknown"` from an ambiguous dispatch there is no `executionId` to check, so an `idempotencyKey` on the original call is the only thing that makes a retry safe — worth setting up front on any dispatch you intend to retry.

- **Addressed by slug.** `definition` is the deployed agent's slug — its stable handle. `input` is passed to its entry step.

- **`idempotencyKey` deduplicates.** Repeating a launch with the same key returns the existing run instead of starting a new one.

- **Delayed dispatch (`at`).** `launch({ definition, input, at })` schedules the child to run at a future time (`at` is a `Date` or ISO 8601 string) instead of now, and returns a **pause-only** handle: hand it to `pauseUntilSignal` and the step resumes with the child's result once the scheduled run finishes. `status`/`wait` aren't available on a delayed handle (there's no run until then), so use `launch` + `pauseUntilSignal`, not `run`. A refused delayed launch throws `AgentDispatchError` like any other; on a SUCCESSFUL one, `status`/`wait` (and so `run`) throw because there is no run to read until the scheduled time. For a plain fire-and-forget one-off (no resume), use the `schedules` capability instead.
