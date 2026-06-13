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

- **`gitRepository` sets up the checkout for you.** Passing a repository clones it into the sandbox at `/workspace/<slug>` with push access already configured — which is exactly what `repo.pushFromSandbox(run.sandbox)` needs afterward. Without it, the agent works in an empty sandbox and there's nothing to push.

- **The sandbox stays alive after the run by default.** This lets a later step read files, run commands, or push from it. Pass `keepSandbox: false` to tear it down automatically when the run finishes (after which you can't push from it).

- **The returned `sandbox` is a live handle.** Use it directly — `run.sandbox.readFile(...)`, `run.sandbox.exec(...)`, `repo.pushFromSandbox(run.sandbox)`. Pass it back as `spec.sandbox` on a follow-up run to chain agents in the same environment.

- **Keep exact, repeatable steps out of the task.** Have the agent write code, and perform actions like git pushes or deploys in your own code (see `repositories.pushFromSandbox`). A `result.success` of `true` means the agent finished — not that anything was published.

- **`workingDirectory` is relative to the run's workspace, not the filesystem root.** Leave it unset to default to the repo checkout (or a fresh per-run workspace); set it to point the agent at a subdirectory.

- **Each run is billed.** Runs that fail or are aborted still cost. Check `run.result?.success` and `run.error` before relying on a run's output.

## Reference

`agent.coding.run(spec)` · `agent.coding.launch(spec)`

See the exported types (`CodingRunSpec`, `CodingRunResult`, `RunHandle`) for full signatures.
