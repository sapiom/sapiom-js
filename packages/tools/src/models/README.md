# agent

Coding agents — give one a task in natural language and it edits a checkout inside a sandbox.

```ts
import { agent, repositories } from "@sapiom/tools";

const repo = await repositories.create("api");
const run = await agent.coding.run({
  task: "Add a /health endpoint that returns 200 OK.",
  gitRepository: repo, // cloned into the sandbox at /workspace/api with push access
});
if (run.result?.success) await repo.pushFromSandbox(run.sandbox, { message: "feat: health" });
```

## Things to know

- **`run` blocks until the agent finishes; `launch` doesn't.** `run` polls to completion, which for a real task can take several minutes. Use `launch` when you'd rather kick off the run, do other work, and check on it yourself with `handle.status()` or `handle.wait()`.

- **`gitRepository` sets up a managed checkout for you.** Pass a repository returned by `repositories.create()`, `repositories.get()`, or `repositories.list()`. `repositories.attach()` can rehydrate one of those handles but cannot import an external Git repository. Without `gitRepository`, the agent works in an empty sandbox and there's nothing to push.

- **The sandbox stays alive after the run by default.** This lets a later step read files, run commands, or push from it. Pass `keepSandbox: false` to tear it down automatically when the run finishes (after which you can't push from it).

- **The returned `sandbox` is a live handle.** Use it directly — `run.sandbox.readFile(...)`, `run.sandbox.exec(...)`, `repo.pushFromSandbox(run.sandbox)`. Pass it back as `spec.sandbox` on a follow-up run to chain agents in the same environment.

- **Keep exact, repeatable steps out of the task.** Have the agent write code, and perform actions like git pushes or deploys in your own code (see `repositories.pushFromSandbox`). A `result.success` of `true` means the agent finished — not that anything was published.

- **`workingDirectory` is relative to the run's workspace, not the filesystem root.** Leave it unset to default to the repo checkout (or a fresh per-run workspace); set it to point the agent at a subdirectory.

- **Each run is billed.** Runs that fail or are aborted still cost. Check `run.result?.success` and `run.error` before relying on a run's output.

- **`deadlineMinutes` says how long you can wait.** Available on both `agent.coding.run`/`launch` and `agent.run`/`launch`. You say the kind of call (`model`) and how long you're willing to wait; the platform derives the billing lane (`run_now` / `priority` / `standard` / `flex`) from that — you never name a lane. **The platform does not honor the deadline yet**: today the field is accepted and sent, and every run still dispatches immediately, so setting it does not yet change dispatch or price. Leaving it unset stays the immediate-dispatch default either way.

- **A deferred run reports `awaiting_capacity`, which is not terminal.** Once deadlines are honored, a run waiting for a cheaper lane sits in this status. `run` keeps polling through it and a `launch` handle keeps waiting, so a deferred run is never resolved with a null result. `wait()`'s default timeout widens to cover the deadline you asked for — a 60-minute deadline doesn't blow the 20-minute default — and an explicit `wait({ timeoutMs })` still overrides it. Polling backs off while a run is parked (doubling, up to a minute between checks) so a long deadline doesn't spend thousands of requests waiting; it returns to the normal interval as soon as the run is moving.

- **Coding HTTP failures are structured.** `run`, `launch`, `handle.status()`, and `handle.wait()` throw `CodingRunHttpError`. Inspect `status`, `code`, `requestId`, and `body`; workflow steps can return `fail(error.message)` for `repository_not_found` and rethrow other errors.

## Reference

`agent.coding.run(spec)` · `agent.coding.launch(spec)`

See the exported types (`CodingRunSpec`, `CodingRunResult`, `RunHandle`, `CodingRunHttpError`) for full signatures.
