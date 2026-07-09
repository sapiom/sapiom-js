# @sapiom/cli

## 0.4.1

### Patch Changes

- 41e9ecd: Add `sapiom sandbox preview [name]` (alias `sbx`): deploy a web-app preview from the current project to a Sapiom sandbox and print the live URL. Reads the sandbox's declared intent from `sapiom.json` (`type: "sandbox"`, singular-default when the project defines exactly one, or pass a name). A `failed` status prints the build/start logs so you can fix and re-run; `--json` emits the structured result.
- Updated dependencies [41e9ecd]
  - @sapiom/sandbox-preview@0.1.2

## 0.4.0

### Minor Changes

- 1d993b2: Emit anonymous `command.run` usage analytics via `@sapiom/analytics-core`.

  - One `command.run` event per executed command (commander `preAction`/`postAction`
    hooks), carrying the command path (e.g. `agents deploy`), the names of the
    flags used — never their values or positional arguments — the duration, and
    the exit status. Tokens and emails never reach event payloads; a signed-in
    credential (from `SAPIOM_API_KEY` or the stored session) is only attached as
    a delivery header for server-side identity enrichment.
  - Ships dark: without an explicitly configured collector endpoint the emitter
    is a silent no-op — zero network calls, zero disk writes, no notice. When
    enabled, analytics-core's one-time first-run notice explains the collection
    and the opt-outs (`SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`).
  - Zero behavior change: enqueue-only delivery (best-effort flush on process
    exit), identical command output and exit codes, and no new required
    configuration.

### Patch Changes

- Updated dependencies [3f25008]
- Updated dependencies [55462b3]
- Updated dependencies [d661d57]
  - @sapiom/analytics-core@0.2.0
  - @sapiom/agent-core@0.9.0
  - @sapiom/agent@0.6.2

## 0.3.2

### Patch Changes

- Updated dependencies [020139a]
- Updated dependencies [3dfbd10]
  - @sapiom/agent@0.6.1
  - @sapiom/agent-core@0.8.0

## 0.3.1

### Patch Changes

- Updated dependencies [7a9d57a]
  - @sapiom/agent@0.6.0
  - @sapiom/agent-core@0.7.0

## 0.3.0

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
  - @sapiom/agent@0.5.0
  - @sapiom/agent-core@0.6.0

## 0.2.5

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

## 0.2.4

### Patch Changes

- a85e665: Add schedules: run a deployed orchestration on a recurring cron schedule or once at a set time.

  - `@sapiom/orchestration-core`: `createSchedule`, `listSchedules`, `getSchedule`, `cancelSchedule`, and `previewCron`.
  - `@sapiom/tools`: a `schedules` namespace (`create`, `list`, `get`, `cancel`).
  - `@sapiom/cli`: `sapiom orchestrations schedule create | list | inspect | cancel | preview`.
  - `@sapiom/mcp`: schedule tools — create, inspect (list/detail + recent fires), cancel, and cron preview.

- Updated dependencies [a85e665]
- Updated dependencies [ae1df3c]
  - @sapiom/orchestration-core@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [56fd77d]
  - @sapiom/orchestration@0.4.0
  - @sapiom/orchestration-core@0.3.4

## 0.2.2

### Patch Changes

- Updated dependencies [f41ab95]
  - @sapiom/orchestration@0.3.0
  - @sapiom/orchestration-core@0.3.3

## 0.2.1

### Patch Changes

- Updated dependencies [b2c5612]
  - @sapiom/orchestration@0.2.0
  - @sapiom/orchestration-core@0.3.2

## 0.2.0

### Minor Changes

- eb5dca2: Add a `staging` environment to host resolution. `resolveHost` maps the `staging` target (alias `dev`) to the staging API host, and the MCP server resolves `SAPIOM_ENVIRONMENT=staging`/`dev`/`prod` from built-in presets without requiring a `~/.sapiom/credentials.json` entry. A file-defined environment still takes precedence.

### Patch Changes

- @sapiom/orchestration@0.1.9
- @sapiom/orchestration-core@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [e17b2d1]
- Updated dependencies [e17b2d1]
  - @sapiom/orchestration-core@0.3.0
  - @sapiom/orchestration@0.1.8

## 0.1.1

### Patch Changes

- Updated dependencies [704c9ac]
  - @sapiom/orchestration-core@0.2.0
  - @sapiom/orchestration@0.1.7
