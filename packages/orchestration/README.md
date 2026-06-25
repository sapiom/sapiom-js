# @sapiom/orchestration

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
npm install @sapiom/orchestration
```

## Authoring surface

```ts
import {
  defineOrchestration,
  defineStep,
  goto,
  terminate,
} from "@sapiom/orchestration";

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

export const hello = defineOrchestration({
  name: "hello",
  entry: "start",
  steps: { start, finish },
});
```

A step declares the transitions it may take (`next` / `terminal` / `canFail` /
`pause`); the `run` return type is derived from those declarations, so an
undeclared transition is a compile error. The build reads those same declarations
to render the orchestration graph without executing anything.

## Pausing on a long-running capability

Some `ctx.sapiom` capabilities are **dispatched**: you launch them, they run far
past one step's budget, and they report back when they finish (a coding agent
today; more below). A step can't inline-`await` one — it pauses, and a later step
resumes with the result. `pauseUntilSignal` accepts the launch handle (or the
launch promise itself) and reads everything it needs off it:

```ts
import { defineStep, pauseUntilSignal, terminate } from "@sapiom/orchestration";
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
      ctx.sapiom.agent.coding.launch({ task: input.task }),
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
    const run = await ctx.sapiom.agent.coding.launch({ task: input.task });
    ctx.shared.set("codingRunId", run.runId); // readable from the resumed step
    return pauseUntilSignal(run, { resumeStep: "review" });
  }
  ```
- **Outside a workflow nothing changes** — `await launch().wait()` the capability as
  usual; the pause wiring only engages when a step pauses on the handle.

### Compatible capabilities

Any capability whose `launch` returns a `DispatchHandle` (a `dispatch` member) is
pausable; each ships a stable result-signal constant for the `pause` decl. This
list grows as capabilities land:

| Capability   | Launch                              | Pause signal                             |
| ------------ | ----------------------------------- | ---------------------------------------- |
| Coding agent | `ctx.sapiom.agent.coding.launch(…)` | `CODING_RESULT_SIGNAL` (`@sapiom/tools`) |

## Compatibility: zod

Author your step schemas with zod the way you normally would:

```ts
import { z } from "zod";
```

Step `inputSchema`s are zod schemas, and the build converts them to JSON Schema
for the manifest — so your project's `zod` is the one to reach for.

If your project is pinned to an older `zod` that the authoring types reject, you
can import a known-good `z` directly from this package instead, without changing
your own `zod`:

```ts
import { z } from "@sapiom/orchestration";
```

This is a compatibility shim, not the recommended import — prefer your own `zod`
unless you hit a version conflict.
