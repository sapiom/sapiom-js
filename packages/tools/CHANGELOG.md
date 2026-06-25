# @sapiom/tools

## 0.6.2

### Patch Changes

- 9fca481: Forward the workflow resume token explicitly via `createClient({ resumeToken })`.

  `agent.coding.run`/`launch` send the per-execution resume token as the `x-sapiom-workflow-token` header so the gateway can resume the paused workflow step. Previously the token was read ONLY from `process.env.SAPIOM_CAPABILITY_RESUME_TOKEN` — fine for the sandbox runtime (which injects that env var) but invisible to the engine's in-process runtime, which must not set process-global env (it would bleed across concurrent step executions sharing the worker). `TransportConfig` now accepts an optional `resumeToken`; the client prefers it and falls back to the env var, so the sandbox path is unchanged and the in-process runtime can pass the token per-call. Additive and backward-compatible.

## 0.6.1

### Patch Changes

- 3d45ec6: Document the `orchestrations` capability: add it to the README's Capabilities table + intro, and add a per-capability `src/orchestrations/README.md` (run a deployed orchestration, or dispatch one from a step and pause on its result).

## 0.6.0

### Minor Changes

- b2c5612: Add the `orchestrations` capability — run a deployed orchestration by slug, or dispatch one from a workflow step and pause on its result.

  ```ts
  import { orchestrations } from "@sapiom/tools";

  // run inline:
  const result = await orchestrations.run({ definition: "enrich-lead", input });

  // or dispatch from a step and resume when it finishes:
  const child = await orchestrations.launch({
    definition: "enrich-lead",
    input,
  });
  return pauseUntilSignal(child, { resumeStep: "use-result" });
  ```

  `launch` returns a handle usable with `pauseUntilSignal`; the resumed step receives an `OrchestrationRunResultPayload` (validate with `orchestrationResultSchema`). Also exports `ORCHESTRATIONS_RESULT_SIGNAL` for the static `pause` declaration on a step.

## 0.5.0

### Minor Changes

- 5c974b1: Add the `contentGeneration` capability — media generation (images today; video and audio to come) with an optional `storage` param that persists each output to Sapiom file storage (each generated image comes back annotated with its own `fileId`, or `storageError`). Exposes `contentGeneration.images.create({ prompt, numImages?, storage? })` via `createClient()`, the ambient `contentGeneration` namespace, or the `@sapiom/tools/content-generation` subpath. Failed requests throw `ContentGenerationHttpError`. Pairs with `fileStorage` — pass `storage` to persist outputs with no extra plumbing.

## 0.4.0

### Minor Changes

- e17b2d1: **BREAKING (`@sapiom/tools`):** align the coding-run resume payload with the shape a resumed step actually receives. `CodingResultPayload` now carries `executionEnvironment: { type, id } | null` instead of `sandbox: { name, workspaceRoot }`. Re-attach a resumed run's sandbox with `ctx.sapiom.sandboxes.attach(result.executionEnvironment.id)` (for a `blaxel_sandbox`).

  Adds `codingResultSchema` (runtime validation of the resume payload), `toResumePayload`, `ExecutionEnvironmentRef`, and `EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX`. The stub client now emits the same payload shape a resumed step receives, so a step written against the local loop runs identically once deployed.

  The `coding-pause` template and its guidance are updated to the new shape.

## 0.3.0

### Minor Changes

- 704c9ac: Make the local development loop (`run_local`) production-faithful and trustworthy for the dispatch/pause pattern (`agent.coding.launch` + `pauseUntilSignal`).

  - Stub capability handles now survive JSON serialization, so a paused/resumed coding workflow runs end-to-end locally instead of failing with an opaque `'sandbox.toJSON' is not a method or field` error.
  - The payload a paused step resumes with is delivered as plain JSON — the same shape production sends over the wire — so authors re-attach handles by name (`sandboxes.attach(...)`) locally exactly as they would in prod.
  - `@sapiom/tools` exports `CodingResultPayload`: the shape a step resumed from `pauseUntilSignal(codingHandle, …)` receives, so resumed steps can be annotated instead of hand-rolling the type.
  - Stubbing a handle-returning capability with plain JSON no longer strips the handle's instance methods (e.g. `repo.pushFromSandbox`), and `repositories.list` stubs are coerced and shape-checked.
  - A dispatched `launch()` accepts the `agent.coding.launch` stub key as well as the shared `agent.coding.run` (ordered candidate resolution), so the stub key matching the call the author wrote takes effect.
  - `run_local` now reports `unusedStubs` (a supplied key that matched no call) and `stubWarnings` (a key that matched but carried the wrong shape), surfacing stubs that silently didn't take effect; the MCP `run_local` also serializes its result defensively.
  - New `coding-pause` scaffold template for the launch + pause + resume pattern, and AGENTS docs documenting the resume-input contract, list stub item shape, failure-branch stubbing, and step determinism under replay.

## 0.2.0

### Minor Changes

- 7f6859e: Add the `fileStorage` capability — tenant-scoped object storage with presigned URLs. Exposes `upload`, `getDownloadUrl`, `list`, `setVisibility`, and `delete` via `createClient().fileStorage`, the ambient `fileStorage` namespace, or the `@sapiom/tools/file-storage` subpath. Failed requests throw `FileStorageHttpError`. You transfer the bytes yourself via the presigned URLs.

## 0.1.3

### Patch Changes

- 2126d96: `repositories.pushFromSandbox` now always publishes the agent's work — it
  commits any pending changes and pushes the current commit, so your work reaches
  the repo whether the agent left changes uncommitted, already committed them, or
  both. (Previously it skipped the push when there were no uncommitted changes.)
  The result now includes `branch` alongside `pushed` and `sha`.

## 0.1.2

### Patch Changes

- be3886e: Add the dispatch→pause→resume authoring surface for long-running capabilities.

  `@sapiom/tools`: new `DispatchHandle` contract + `CODING_RESULT_SIGNAL`; coding-run
  handles now carry a `dispatch` member, and `launch` forwards the engine-injected
  `SAPIOM_CAPABILITY_RESUME_TOKEN` as the `x-sapiom-workflow-token` header.

  `@sapiom/orchestration`: `pauseUntilSignal` accepts a `DispatchHandle |
Promise<DispatchHandle>` so a step can pause on a launched capability with
  `pauseUntilSignal(ctx.sapiom.agent.coding.launch(...), { resumeStep })`.

  Additive and non-breaking — standalone `agent.coding.launch` is unchanged.
