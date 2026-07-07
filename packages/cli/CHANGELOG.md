# @sapiom/cli

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
