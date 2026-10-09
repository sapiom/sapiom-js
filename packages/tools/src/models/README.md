# models

Model calls from a step. `models.run` runs the managed loop: Sapiom's server sends your prompt to a model, calls tools on the remote MCP servers you pass, and returns text. `models.coding.run` gives a coding agent a task in natural language and it edits a checkout inside a sandbox.

```ts
import { models } from "@sapiom/tools";

const run = await models.run({
  prompt:
    "List the open issues labelled `bug` and summarize them in three bullets.",
  system: "You are a concise triage assistant.",
  mcps: [
    {
      url: "https://mcp.example.com/mcp",
      headers: { authorization: `Bearer ${token}` },
    },
  ],
});
if (run.status === "completed") console.log(run.output);
```

```ts
import { models, repositories } from "@sapiom/tools";

const repo = await repositories.create("api");
const run = await models.coding.run({
  task: "Add a /health endpoint that returns 200 OK.",
  gitRepository: repo, // cloned into the sandbox at /workspace/api with push access
});
if (run.result?.success)
  await repo.pushFromSandbox(run.sandbox, { message: "feat: health" });
```

## Things to know

- **`models.run` is the managed loop.** The loop runs in Sapiom's server with no sandbox and no filesystem. Its tools are the remote MCP servers in `mcps` (Streamable HTTP; each tool call is a network round-trip). The result carries `status`, `output` (the final text), `result` (turns, usage, `servedClass`, `warnings`) and `error`.

- **Omit `model`.** The platform routes the run. `model` takes a model label (`"small"`, `"medium"`, `"large"`), never a raw provider model id. An unrecognized label routes via the platform default and is reported in `result.warnings`.

- **`run` blocks until the run finishes; `launch` doesn't.** `run` polls to completion, which for a coding task can take several minutes. Use `launch` to start the run and either check on it yourself with `handle.status()` / `handle.wait()`, or hand the handle to `pauseUntilSignal(handle, { resumeStep })` so the step pauses and `resumeStep` receives the result. Only `models.launch` and `models.coding.launch` return a handle; `models.run` and `models.coding.run` return the finished result, which cannot be paused on.

- **`gitRepository` sets up a managed checkout for you.** Pass a repository returned by `repositories.create()`, `repositories.get()`, or `repositories.list()`. `repositories.attach()` can rehydrate one of those handles but cannot import an external Git repository. Without `gitRepository`, the coding agent works in an empty sandbox and there's nothing to push.

- **The sandbox stays alive after a coding run by default.** This lets a later step read files, run commands, or push from it. Pass `keepSandbox: false` to tear it down automatically when the run finishes (after which you can't push from it).

- **The returned `sandbox` is a live handle.** Use it directly — `run.sandbox.readFile(...)`, `run.sandbox.exec(...)`, `repo.pushFromSandbox(run.sandbox)`. Pass it back as `spec.sandbox` on a follow-up coding run to chain runs in the same environment.

- **Keep exact, repeatable steps out of the task.** Have the coding agent write code, and perform actions like git pushes or deploys in your own code (see `repositories.pushFromSandbox`). A `result.success` of `true` means the run finished — not that anything was published.

- **`workingDirectory` is relative to the run's workspace, not the filesystem root.** Leave it unset to default to the repo checkout (or a fresh per-run workspace); set it to point the coding agent at a subdirectory.

- **Each run is billed.** Runs that fail or are aborted still cost. Check `run.status` / `run.result?.success` and `run.error` before relying on a run's output.

- **`deadlineMinutes` says how long you can wait.** Available on `models.run`/`launch` and `models.coding.run`/`launch`. You give the model label (`model`) and how long you're willing to wait; the platform derives the billing tier from that. **The platform does not honor the deadline yet**: today the field is accepted and sent, and every run still dispatches immediately, so setting it does not yet change dispatch or price. Leaving it unset stays the immediate-dispatch default either way.

- **A deferred run reports `awaiting_capacity`, which is not terminal.** Once deadlines are honored, a run waiting for a cheaper tier sits in this status. `run` keeps polling through it and a `launch` handle keeps waiting, so a deferred run is never resolved with a null result. `wait()`'s default timeout widens to cover the deadline you asked for — a 60-minute deadline doesn't blow the default (20 minutes for a coding run, 10 for `models.run`) — and an explicit `wait({ timeoutMs })` still overrides it. Polling backs off while a run is parked (doubling, up to a minute between checks) so a long deadline doesn't spend thousands of requests waiting; it returns to the normal interval as soon as the run is moving.

- **Coding HTTP failures are structured.** `models.coding.run`, `models.coding.launch`, `handle.status()`, and `handle.wait()` throw `CodingRunHttpError`. Inspect `status`, `code`, `requestId`, and `body`; agent steps can return `fail(error.message)` for `repository_not_found` and rethrow other errors.

## Reference

`models.run(spec)` · `models.launch(spec)` · `models.coding.run(spec)` · `models.coding.launch(spec)`

See the exported types (`ModelRunSpec`, `ModelRunResult`, `ModelRunHandle`, `CodingRunSpec`, `CodingRunResult`, `RunHandle`, `CodingRunHttpError`) for full signatures.
