# @sapiom/mcp

## 0.9.1

### Patch Changes

- Updated dependencies [7a9d57a]
  - @sapiom/agent-core@0.7.0

## 0.9.0

### Minor Changes

- cc1261e: Rename the composition SDK to **agents** and the coding/LLM capability to **models**.

  **Breaking — the package names changed. Install the new names; the old ones are deprecated.**

  - Packages: `@sapiom/orchestration` → `@sapiom/agent`, `@sapiom/orchestration-core` → `@sapiom/agent-core`, `@sapiom/orchestration-runtime` → `@sapiom/agent-runtime`. (`@sapiom/create-orchestration` is retired — scaffold with the CLI or the developer MCP.)
  - API: `defineOrchestration` → `defineAgent`; `Orchestration*` types/errors → `Agent*`.
  - `@sapiom/tools`: the `agent` capability namespace is now `models` (e.g. `sapiom.models.coding`); the `orchestrations` namespace is now `agents`.
  - CLI: `sapiom orchestrations …` → `sapiom agents …`.
  - Developer MCP tools: `sapiom_dev_orchestrations_*` → `sapiom_dev_agents_*`.

### Patch Changes

- Updated dependencies [cc1261e]
  - @sapiom/agent-core@0.6.0

## 0.8.2

### Patch Changes

- f2f4fec: Bring `inspect()` / `listExecutions()` to REST `ExecutionProjection` parity (tree + per-node cost + trace refs), replacing the flat inspection shape.

  **Breaking (return shapes):**

  - `inspect(opts, client)` now resolves the decoded `ExecutionProjection` **directly** (previously `{ execution }`). It carries the dispatch tree (`traceRoot`/`traceParent`/`traceId`/`spanId`, `parentExecutionId`/`rootExecutionId`, typed `children`), per-step `spanId`/`events`/`dispatch`, and a structured `StepError` (`trace` is now a `StepErrorTrace` of source-mapped frames, not a string).
  - `listExecutions(client)` now resolves `ExecutionRef[]` **directly** (previously `{ executions }`).
  - The flat `ExecutionDetail` / `StepRecord` types are removed; import the new projection types (`ExecutionProjection`, `StepProjection`, `CostNode`, `ExecutionRef`, `DispatchRef`, `StepError`, `StepEvent`) instead.

  **Cost is honest, never fabricated:** `cost` is `CostNode | null` at run and step granularity. The execution-detail read is cost-agnostic today (authoritative cost lives at `/executions/:id/spend`), so an absent cost decodes to `null`, not a misleading `$0`. `authorizedUsd`/`capturedUsd`/`settleState` are never collapsed when cost is present.

  The engine must emit the corresponding fields (per-node cost, list lineage, named child edges) for the projection to be fully populated; until then `inspect()`/`listExecutions()` degrade honestly rather than throwing. SDK pins move in lockstep with the engine.

- Updated dependencies [f2f4fec]
  - @sapiom/orchestration-core@0.5.0

## 0.8.1

### Patch Changes

- 148988f: Reframe `@sapiom/mcp` as the local Sapiom developer MCP (`sapiom-dev`) to stop it being conflated with the remote `sapiom` capability MCP.

  Two servers brand as "Sapiom": the remote `sapiom` MCP is the production capability surface (paid, gateway-routed — `sapiom_sandbox_*`, scrape, search, …); this package is the local `sapiom-dev` MCP — the unmetered `sapiom_dev_*` developer surface for building and operating on Sapiom (today it scaffolds, tests, deploys, and inspects orchestrations) and it exposes no capability tools. The dividing line is billing, not task: the `sapiom_dev_*` namespace is reserved for developer tooling and never makes a paid capability call. The runtime server names already differed, but the package/registry name and descriptions read generically.

  - Adds a `packages/mcp/README.md` framing the package as the local developer MCP, with the `npx -y @sapiom/mcp` install snippet, `SAPIOM_ENVIRONMENT` config, and the `sapiom_authenticate` browser-login flow.
  - Sets a client-facing `title` ("Sapiom Dev — local developer tools") and `description` on the MCP server; the wire `name` stays `sapiom-dev`.
  - Sharpens the `package.json` / `server.json` descriptions and the `sapiom_authenticate` / `sapiom_status` tool descriptions to say which Sapiom this is.

  Docs-only / metadata change — no behavior change to either MCP.
  - @sapiom/orchestration-core@0.4.2

## 0.8.0

### Minor Changes

- f0167c0: Deliver the workflow-authoring primer through the MCP server `instructions` field. Capable MCP clients surface it to the model on connect, so an agent that adds `@sapiom/mcp` gets the authoring lifecycle (authenticate → scaffold → check/run_local → deploy/run) and the canonical `@sapiom/orchestration` rules automatically. The primer is concise and points to the full documentation (docs.sapiom.ai/workflows) and the scaffold's `AGENTS.md`.

## 0.7.2

### Patch Changes

- a85e665: Add schedules: run a deployed orchestration on a recurring cron schedule or once at a set time.

  - `@sapiom/orchestration-core`: `createSchedule`, `listSchedules`, `getSchedule`, `cancelSchedule`, and `previewCron`.
  - `@sapiom/tools`: a `schedules` namespace (`create`, `list`, `get`, `cancel`).
  - `@sapiom/cli`: `sapiom orchestrations schedule create | list | inspect | cancel | preview`.
  - `@sapiom/mcp`: schedule tools — create, inspect (list/detail + recent fires), cancel, and cron preview.

- Updated dependencies [a85e665]
- Updated dependencies [ae1df3c]
  - @sapiom/orchestration-core@0.4.0

## 0.7.1

### Patch Changes

- 9fca481: Fix `sapiom_dev_orchestrations_run` rejecting valid input as "input must be an object".

  The real-run tool passed the `input` argument straight through, but some MCP clients serialize object-valued args as a JSON string — so the execution API (which requires an object) received `"{}"` and returned HTTP 400. `run_local` already normalized this with `coerceJson`; the real-run path now does the same and defaults an absent input to `{}`. Brings the two paths into parity.

## 0.7.0

### Minor Changes

- eb5dca2: Add a `staging` environment to host resolution. `resolveHost` maps the `staging` target (alias `dev`) to the staging API host, and the MCP server resolves `SAPIOM_ENVIRONMENT=staging`/`dev`/`prod` from built-in presets without requiring a `~/.sapiom/credentials.json` entry. A file-defined environment still takes precedence.

### Patch Changes

- @sapiom/orchestration-core@0.3.1

## 0.6.0

### Minor Changes

- e17b2d1: `scaffold` now initializes a git repository with an initial commit, so a freshly scaffolded project is immediately deployable (deploy requires a repo with at least one commit). Best-effort: if `git` is unavailable the project is left uninitialized. `ScaffoldResult` gains `gitInitialized`.

  Adds `waitForExecution` (and `isExecutionTerminal`) to poll an execution until it reaches a terminal state, settles on a pause that needs a signal, or a wait budget elapses — so callers don't hand-roll a poll loop. The `sapiom_dev_orchestrations_inspect` MCP tool gains opt-in `wait` / `maxWaitSeconds` options that use it and return `done` / `waiting` / `hint`; a non-blocking inspect of a still-running execution now also hints to use `wait`.

  Fixes `sapiom_dev_orchestrations_link`: omitting `name` no longer sends an empty name (which the gateway rejected). It now defaults to the orchestration's name read from `index.ts` (matching `defineOrchestration({ name })`), and returns a clear error if no name is available.

### Patch Changes

- Updated dependencies [e17b2d1]
- Updated dependencies [e17b2d1]
  - @sapiom/orchestration-core@0.3.0

## 0.5.1

### Patch Changes

- 704c9ac: Make the local development loop (`run_local`) production-faithful and trustworthy for the dispatch/pause pattern (`agent.coding.launch` + `pauseUntilSignal`).

  - Stub capability handles now survive JSON serialization, so a paused/resumed coding workflow runs end-to-end locally instead of failing with an opaque `'sandbox.toJSON' is not a method or field` error.
  - The payload a paused step resumes with is delivered as plain JSON — the same shape production sends over the wire — so authors re-attach handles by name (`sandboxes.attach(...)`) locally exactly as they would in prod.
  - `@sapiom/tools` exports `CodingResultPayload`: the shape a step resumed from `pauseUntilSignal(codingHandle, …)` receives, so resumed steps can be annotated instead of hand-rolling the type.
  - Stubbing a handle-returning capability with plain JSON no longer strips the handle's instance methods (e.g. `repo.pushFromSandbox`), and `repositories.list` stubs are coerced and shape-checked.
  - A dispatched `launch()` accepts the `agent.coding.launch` stub key as well as the shared `agent.coding.run` (ordered candidate resolution), so the stub key matching the call the author wrote takes effect.
  - `run_local` now reports `unusedStubs` (a supplied key that matched no call) and `stubWarnings` (a key that matched but carried the wrong shape), surfacing stubs that silently didn't take effect; the MCP `run_local` also serializes its result defensively.
  - New `coding-pause` scaffold template for the launch + pause + resume pattern, and AGENTS docs documenting the resume-input contract, list stub item shape, failure-branch stubbing, and step determinism under replay.

- Updated dependencies [704c9ac]
  - @sapiom/orchestration-core@0.2.0

## 0.5.0

### Minor Changes

- 658e8fb: New: SDK Identity Token Lifecycle. Adds automatic Sapiom-Identity JWT management across all SDK packages. The SDK lazily fetches identity tokens from POST /v1/auth/tokens, caches them in-memory, and attaches the Sapiom-Identity header to requests whose target hostname matches the token's aud claim (direct or subdomain match).

### Patch Changes

- Updated dependencies [658e8fb]
  - @sapiom/core@0.5.0
  - @sapiom/fetch@0.5.0

## 0.4.0

### Minor Changes

- c9ad2cb: add create transaction scoped API key functionality

### Patch Changes

- Updated dependencies [c9ad2cb]
- Updated dependencies [c9ad2cb]
  - @sapiom/core@0.4.0
  - @sapiom/fetch@0.4.0

## 0.3.0

### Minor Changes

- 3f37cff: update MCP registry schema to latest

## 0.2.0

### Minor Changes

- 8423815: implement `@sapiom/mcp`, minor code formatting

### Patch Changes

- Updated dependencies [70a05be]
- Updated dependencies [8423815]
  - @sapiom/fetch@0.3.0
  - @sapiom/core@0.3.0
