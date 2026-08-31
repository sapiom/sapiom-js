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
import { defineStep, pauseUntilSignal } from "@sapiom/agent";

const enrich = defineStep({
  name: "enrich",
  pause: { signal: agents.AGENTS_RESULT_SIGNAL, resumeStep: "use-result" },
  async run(input, ctx) {
    const child = await agents.launch({ definition: "enrich-lead", input });
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

- **Failure is data, not an exception.** The result is discriminated on `status` (`"completed" | "failed"`). A failed run resumes your step with `status: "failed"` and an `error` to branch on — it does not throw. Validate an incoming payload with `agents.agentResultSchema.parse(value)` if you want a runtime check.

### Runtime provenance (internal)

Instrumented bundles may associate an opaque v1 callsite token with an agent
invocation through `@sapiom/tools/_internal/agent-runtime-provenance`. The token
travels in dedicated request headers, never in `AgentRunSpec` or its JSON body.
When a terminal response carries a supported server-signed lineage receipt, the
SDK retains it in object-identity sidecars on the returned result and its exact
object-valued `output`. One receipt can be forwarded once, only when one of those
exact objects is the direct `input` of an immediate invocation carrying a valid
v1 build callsite. An uninstrumented agent invocation consumes the sidecar
without forwarding it, a timer turn expires it, and delayed dispatch never sends
runtime provenance. Copies, nested values, and transformed primitives do not
inherit the sidecar.

The detectable boundary is intentionally narrower than arbitrary data-flow
tracking: the SDK does not recursively inspect values and cannot distinguish a
synchronous exact-reference round trip through an in-memory array or `Map` from
a direct handoff before the one-turn sidecar expires. Queue/storage exclusion is
therefore guaranteed only when the boundary changes object identity, crosses a
timer turn, or invokes an uninstrumented agent boundary (which consumes the
receipt). The package's CJS and ESM root/carrier exports route through one
canonical closure-backed implementation, so supported mixed-format callsites and
result handoffs share the same private state without a process-global store or
public extraction/rebinding helpers. All four cross-format directions are tested.
The SDK treats all carrier values as opaque and exposes no new caller, callee,
bundle, or execution identity. Missing or unsupported metadata preserves legacy
behavior.

- **Addressed by slug.** `definition` is the deployed agent's slug — its stable handle. `input` is passed to its entry step.

- **`idempotencyKey` deduplicates.** Repeating a launch with the same key returns the existing run instead of starting a new one.

- **Delayed dispatch (`at`).** `launch({ definition, input, at })` schedules the child to run at a future time (`at` is a `Date` or ISO 8601 string) instead of now, and returns a **pause-only** handle: hand it to `pauseUntilSignal` and the step resumes with the child's result once the scheduled run finishes. `status`/`wait` aren't available on a delayed handle (there's no run until then), so use `launch` + `pauseUntilSignal`, not `run`. For a plain fire-and-forget one-off (no resume), use the `schedules` capability instead.
