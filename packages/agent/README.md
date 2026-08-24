# @sapiom/agent

The versioned public contract for authoring Sapiom orchestrations.

A lean, dependency-light package (types + a small protocol runtime) shared by
three consumers:

- **Customer orchestration definitions** — authored against this package's types and
  compiled by the build.
- **The sandbox step-runner** — reads a step's input, builds `ctx`, runs one step.
- **The engine** — uses the directive guards + manifest schema; it never runs
  customer code, only validates the pure-data completion payload.

## Install

```sh
npm install @sapiom/agent
```

## Authoring surface

```ts
import {
  defineAgent,
  defineStep,
  goto,
  terminate,
} from "@sapiom/agent";

const start = defineStep({
  name: "start",
  next: ["finish"],
  async run(input, ctx) {
    return goto("finish", { greeting: `hello ${input.name}` });
  },
});

const finish = defineStep({
  name: "finish",
  next: [],
  terminal: true,
  async run() {
    return terminate({ done: true });
  },
});

export const hello = defineAgent({
  name: "hello",
  entry: "start",
  steps: { start, finish },
});
```

A step declares the transitions it may take (`next` / `terminal` / `canFail` /
`pause`); the `run` return type is derived from those declarations, so an
undeclared transition is a compile error. The build reads those same declarations
to render the orchestration graph without executing anything.

## The entry input contract

A step's `inputSchema` (a zod schema, imported from `zod/v4`) types and validates that
step's input. The **entry step's `inputSchema` is special — it is the agent's public API**:
the dashboard Run form, the trigger snippet, and the engine's pre-dispatch validation are
all derived from it. Declare it on the entry step, with a `.default()` on each field so a
zero-input run still validates:

```ts
import { defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

const start = defineStep({
  name: "start",
  next: [],
  terminal: true,
  inputSchema: z.object({
    repo: z.string().default("sapiom/sapiom"),
  }),
  // `input` is inferred + validated from inputSchema: { repo: string }
  async run(input) {
    return terminate({ scanned: input.repo });
  },
});
```

`inputSchema` on a non-entry step types that step's inbound payload the same way — including
a **resumed** step's signal payload, shown next.

## Cross-step state and its quota

`ctx.shared` is the typed key/value store for compact state that several later
steps need. Its **entire snapshot** may contain at most **256 KiB (262,144
bytes), inclusive**, measured as the UTF-8 byte length of compact
`JSON.stringify(snapshot)`. Keys, JSON punctuation, existing values, and the
new value all count toward the same limit.

The SDK's `InMemoryContextStore.set()` synchronously measures the complete
candidate snapshot before committing it. An oversized or unserializable
candidate throws and leaves the previous snapshot unchanged. Hosts gain this
setter-time gate when they construct this store version; hosts that have not
adopted it may enforce the contract only at execution boundaries during rollout.

Measurement follows `JSON.stringify` rather than a stricter JSON-value
validator: values JSON normally omits or coerces retain those semantics, while
circular references, BigInt values, and throwing `toJSON` methods are rejected.

Keep small scalars, IDs, and durable-storage references in `ctx.shared`. Put
bulk API responses, documents, research results, and other large state in
durable storage, then carry only the resulting ID or reference. The stable
machine code for an oversized candidate is `CTX_SHARED_SIZE_LIMIT_EXCEEDED`;
JSON encoding failures use `CTX_SHARED_SERIALIZATION_FAILED`. Use the exported
structural guards and structured fields rather than parsing messages or relying
on `instanceof`: the host runner and an authored definition may carry separate
inlined SDK copies.

`TypedContextStore` has no `delete()` operation. To recover from legacy invalid
state, replace an offending key with a compact, JSON-compatible value small
enough to bring the complete candidate within the quota.

## Pausing on a long-running capability

Some `ctx.sapiom` capabilities are **dispatched**: you launch them, they run far
past one step's budget, and they report back when they finish (a coding agent
today; more below). A step can't inline-`await` one — it pauses, and a later step
resumes with the result. `pauseUntilSignal` accepts the launch handle (or the
launch promise itself) and reads everything it needs off it:

```ts
import { defineStep, pauseUntilSignal, terminate } from "@sapiom/agent";
import { CODING_RESULT_SIGNAL } from "@sapiom/tools";

const code = defineStep({
  name: "code",
  next: ["review"],
  // capability's exported signal constant so the decl can't drift from the handle.
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "review" },
  async run(input, ctx) {
    // launch returns immediately; hand it straight to pauseUntilSignal. The run
    // parks at status='paused' and the dispatch loop exits.
    return pauseUntilSignal(
      ctx.sapiom.models.coding.launch({ task: input.task }),
      {
        resumeStep: "review",
      },
    );
  },
});

const review = defineStep({
  name: "review",
  next: [],
  terminal: true,
  // Give this step an `inputSchema` (a zod schema for the capability's result
  // shape) to type + validate what it receives.
  async run(result, ctx) {
    // Fires on success OR failure — branch on the terminal result.
    return terminate({ ok: result.status === "completed" });
  },
});
```

Things to know:

- **The pause is a real suspend across processes**, so the launch and the resume
  are two steps — you can't fold them into one inline `await`.
- **The resumed step receives the capability's result as its input.** Declare its
  `inputSchema` to type + validate it (each capability documents its result shape).
- **Pass the launch promise directly** for the one-liner above, or `await` it first
  when you need the handle — to stash the run id in `ctx.shared`, or to `try/catch`
  a launch failure and route somewhere other than a retry. Awaiting doesn't lose
  the pause; the resolved handle still flows into `pauseUntilSignal`:

  ```ts
  async run(input, ctx) {
    const run = await ctx.sapiom.models.coding.launch({ task: input.task });
    ctx.shared.set("codingRunId", run.runId); // readable from the resumed step
    return pauseUntilSignal(run, { resumeStep: "review" });
  }
  ```
- **Outside an agent run nothing changes** — `await launch().wait()` the capability as
  usual; the pause wiring only engages when a step pauses on the handle.

### Compatible capabilities

Any capability whose `launch` returns a `DispatchHandle` (a `dispatch` member) is
pausable; each ships a stable result-signal constant for the `pause` decl. This
list grows as capabilities land:

| Capability   | Launch                              | Pause signal                             |
| ------------ | ----------------------------------- | ---------------------------------------- |
| Coding agent | `ctx.sapiom.models.coding.launch(…)` | `CODING_RESULT_SIGNAL` (`@sapiom/tools`) |
