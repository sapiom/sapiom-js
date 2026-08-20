# Working in this agent project

This project defines exactly one Sapiom agent in `index.ts`, authored against `@sapiom/agent`. Inside a step's `run`, Sapiom capabilities are on `ctx.sapiom` (e.g. `ctx.sapiom.repositories.list()`, `repo.pushFromSandbox(...)`).

The full authoring guide ships inside this project at `.claude/skills/sapiom-agent-authoring/SKILL.md` — read it for the step model, directives, failure patterns, pause/resume, and stub rules.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck.

## The entry input contract

The **entry step's `inputSchema` is this agent's public API** — the dashboard Run form, the trigger snippet, and engine-side validation are all generated from it. Declare it (with `zod` from `zod/v4`) even when the agent looks input-free, and give every field a `.default()` so a zero-input run (the empty Run form) still validates. An entry step with no `inputSchema` tells the platform the agent takes no input — the Run form renders empty and `check` warns.

```ts
import { defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

const start = defineStep({
  name: "start",
  next: [],
  terminal: true,
  inputSchema: z.object({
    repo: z.string().default("sapiom/sapiom"),
    window: z.enum(["day", "week", "month"]).default("week"),
  }),
  async run(input, ctx) {
    // input: { repo: string; window: "day" | "week" | "month" }
    return terminate({ scanned: input.repo });
  },
});
```

`inputSchema` on a non-entry step validates that step's inbound payload — but only the entry step's schema is read as the agent's public contract.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — this project ships a near-complete local suite. Reach for it then; you don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** — runs your **real** step code locally against **stub capabilities**: every `ctx.sapiom.*` call (namespace calls _and_ handle methods like `repo.pushFromSandbox`) returns a built-in default, so an agent run completes end-to-end with zero setup. Returns a per-step trace.
- **deploy** — ship it.

Only `ctx.sapiom.*` calls are replaced. Definition imports and step bodies are ordinary local code, so direct network requests, filesystem writes, environment reads, and child processes still happen during `check` or `run_local`.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

## Stubs (overrides)

`run_local` works with **no stubs** — capabilities return sensible defaults. Add an override only when a step's logic branches on a specific result (e.g. "if `repositories.list()` already contains my repo, skip create"). Put overrides in `.sapiom-dev/stubs.json` (committed and human-reviewable); `run_local` reads it automatically. Shape:

```jsonc
{ "version": 1, "steps": { "<stepName>": { "<capability.path>": <response> } } }
```

- Capability paths are namespace methods (`repositories.list`, `repositories.create`, `models.coding.run`) or handle methods, which use the **singular** handle type (`repository.pushFromSandbox`, `sandbox.exec`) — not the plural namespace.
- `<response>` is returned **verbatim** — it is the value that call would return, so match its real shape. `repositories.list` takes the array `list()` returns: `[{ "slug": "...", "cloneUrl": "..." }]` (each element a repository — _not_ `[[ … ]]`). `repositories.create`/`get`/`attach` take a single `{ "slug", "cloneUrl" }`.
- `run_local` reports **`unusedStubs`** (a key that matched no call — usually a typo or the plural/singular mistake) and **`stubWarnings`** (a key matched but the value was the wrong shape). A green run with either non-empty means a stub silently didn't take effect — check them.

## Dispatched runs: pause & resume

A long-running capability (today the coding agent) is launched fire-and-forget and the agent run suspends until it finishes:

```ts
const run = await ctx.sapiom.models.coding.launch({
  task,
  gitRepository: repo,
}); // returns a handle, not a result
return pauseUntilSignal(run, { resumeStep: "finalize" }); // suspend on the run's result signal
```

- **The resumed step's `input` IS the run's result signal payload.** Annotate it with `CodingResultPayload` (from `@sapiom/tools`) — you don't have to hand-roll the shape.
- That payload crossed a wire boundary, so it carries **no live handles** — to act on the run's sandbox, re-attach one from **`executionEnvironment`** with `ctx.sapiom.sandboxes.attach(result.executionEnvironment.id)` (`executionEnvironment` is `null` when the run provisioned none, e.g. a launch failure). Anything else the resumed step needs, stash in `ctx.shared` before pausing.
- **To stub the resume payload** (e.g. to exercise the failure branch), override `models.coding.run` _in the launching step_ — that one value is both the `run()` result and the payload the paused step resumes with. `models.coding.launch` is accepted there too.
- `gitRepository` must be an active Sapiom repository returned by `repositories.create`, `get`, or `list`. `repositories.attach` only rehydrates a previously returned handle; it makes no request and cannot import an external Git origin. Coding launch sends its slug, not the attached `cloneUrl`.
- Coding launch and polling throw `CodingRunHttpError` on HTTP failures. A step with `canFail: true` can catch `code === "repository_not_found"` and return `fail(error.message)` to stop immediately; rethrow failures that may be transient.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Don't rely on a value being recomputed identically across a pause/resume — capture non-deterministic values (timestamps, ids) once and pass them forward via the `goto(...)` input or `ctx.shared`.
