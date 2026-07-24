# @sapiom/orchestration-core

## 0.9.9

### Patch Changes

- b6b9d16: Harden deploy and local-run input handling:

  - Redact credentials from git error output, so a push URL's embedded token can never leak into an error hint or the deploy stream.
  - On an auth-class deploy-push failure, mint a fresh push credential and retry the push once.
  - Report a superseded build as a distinct, non-alarming outcome (a newer deploy replaced this build) instead of a generic build failure.
  - Default an absent local-run input to `{}`, so a step that reads its input behaves the same locally as it does in a production run.

## 0.9.8

### Patch Changes

- Updated dependencies [68d2352]
  - @sapiom/tools@0.22.0
  - @sapiom/agent@0.6.7

## 0.9.7

### Patch Changes

- Updated dependencies [d00b9e3]
  - @sapiom/tools@0.21.0
  - @sapiom/agent@0.6.6

## 0.9.6

### Patch Changes

- Updated dependencies [4cf0156]
  - @sapiom/tools@0.20.0
  - @sapiom/agent@0.6.5

## 0.9.5

### Patch Changes

- c8eecf0: fix(agent-core): refresh stale offline scaffold version fallback

  `VERSION_FALLBACK` drifted after the last version bump (agent `0.6.2` → `0.6.4`,
  tools `0.17.2` → `0.19.0`), so an offline/registry-hiccup scaffold would pin
  versions that no longer match what's published. Bumped to match the workspace
  package.json, which is what the regression test guards.

## 0.9.4

### Patch Changes

- Updated dependencies [e446a4a]
  - @sapiom/tools@0.19.0
  - @sapiom/agent@0.6.4

## 0.9.3

### Patch Changes

- 0c6bcb4: Fix `scaffold()`'s offline fallback versions (`@sapiom/agent@0.1.1`, `@sapiom/tools@0.1.1`) — neither exists on npm anymore (currently published: `agent@0.5.0`, `tools@0.16.0`). Any scaffold that fell back to these (no network, npm registry unreachable, corporate proxy, etc.) produced a project whose first `npm install` failed with `ETARGET`. Bumped to the current published versions and added a regression test that checks the fallback against the workspace's own package versions, so this can't silently drift again.
- Updated dependencies [afc77e3]
  - @sapiom/tools@0.18.0
  - @sapiom/agent@0.6.3

## 0.9.2

### Patch Changes

- 696f111: Ship the skills/ directory in the published package so the bundled sapiom-agent-authoring skill is available after a real install.
- 48fb35c: Correct stub capability path in template docs (models.coding.\*); refresh offline scaffold version fallback.

  - Replace stale `agent.coding.run` / `agent.coding.launch` references with the
    correct `models.coding.run` / `models.coding.launch` in all template docs
    (`templates/default/AGENTS.md`, `templates/coding-pause/AGENTS.md`,
    `templates/coding-pause/README.md`). The old path matched no stub, causing
    silent no-ops in local runs.
  - Bump `VERSION_FALLBACK` in `scaffold.ts` from `{ agent: "0.1.1", tools: "0.1.1" }`
    to `{ agent: "0.6.2", tools: "0.17.1" }` to match current package versions.
    Only affects offline scaffolds (the online path still resolves npm-latest).

- 58ec57f: Fix Sapiom skill registration in harness sessions. `@sapiom/agent-core` now
  exposes its `package.json` through the `exports` map so consumers can resolve
  its bundled `skills/` directory; previously `require.resolve` threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED` and the skill silently never loaded. The harness
  skill-plugin resolver also gains a fallback that locates the skills directory by
  resolving the package's main entry when the `package.json` subpath isn't
  exported. Skills register under the `sapiom` plugin namespace, so the
  agent-authoring skill is available as `/sapiom:sapiom-agent-authoring`.
- Updated dependencies [95bfcd1]
- Updated dependencies [bf44229]
- Updated dependencies [dab6d44]
- Updated dependencies [ebfa0bc]
  - @sapiom/analytics-core@0.2.1

## 0.9.1

### Patch Changes

- 7fa17d1: Align agent run and schedule requests with the current API endpoints. This also fixes `@sapiom/tools` `schedules` operations (create/list/get/cancel), which were targeting an outdated endpoint. Public function signatures are unchanged.
- Updated dependencies [7fa17d1]
  - @sapiom/tools@0.17.1

## 0.9.0

### Minor Changes

- d661d57: Emit workflow lifecycle usage analytics from the agent package family via `@sapiom/analytics-core` (source `"agent"`).

  - `@sapiom/agent-core`: `link` / `deploy` / `run` emit one `workflow.link` / `workflow.deploy` / `workflow.run` event each, carrying metadata only — workflow name/id, duration, status, and a machine-readable error code on failure (never inputs, outputs, or error messages). The emitter is constructed lazily at the operation call boundary; `GatewayClient` stays env-free. `runLocal` emits the runtime's step lifecycle events flagged `local: true`.
  - `@sapiom/agent-runtime`: `AgentRunnerCore` accepts an optional `analytics` sink (new `RuntimeAnalytics` host interface — a structural `track()` method, no new dependency) and emits `step.start` / `step.complete` / `step.error` with step name, attempt, and timing. No sink → no events, byte-for-byte previous behavior.

  Telemetry ships dark: without a collector endpoint configured (`SAPIOM_ANALYTICS_ENDPOINT`) every `track` is a silent no-op — zero network calls, zero disk writes. Opt out any time with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`. Emission is synchronous enqueue-only and can never change an operation's behavior, results, or errors — collector outages included.

### Patch Changes

- Updated dependencies [3f25008]
- Updated dependencies [55462b3]
- Updated dependencies [d661d57]
- Updated dependencies [aee376a]
  - @sapiom/analytics-core@0.2.0
  - @sapiom/agent-runtime@0.4.0
  - @sapiom/tools@0.17.0
  - @sapiom/agent@0.6.2

## 0.8.0

### Minor Changes

- 3dfbd10: Ship the `sapiom-agent-authoring` skill with every scaffold, and finish the MCP
  instructions rename.

  - New canonical skill (`agent-core/skills/sapiom-agent-authoring/SKILL.md`) with a
    task-shape trigger ("automate a multi-step / scheduled / deployable task"), the full
    authoring guide (`defineAgent`, directives, pause/resume, stubs), and a bootstrap
    step for agents whose client doesn't have the sapiom-dev MCP yet.
  - Both scaffold templates ship it at `.claude/skills/sapiom-agent-authoring/` (auto-loads
    as a project skill in Claude Code) and `AGENTS.md` points to it, so every scaffolded
    project self-documents. A sync test keeps template copies identical to the canonical.
  - `@sapiom/mcp`'s bundled instructions fallback rewritten to the agents/models
    vocabulary (the rename left it on the old text), thinned to lifecycle + canonical
    rules + pointers — deep guidance lives in the skill/AGENTS.md/docs.

### Patch Changes

- 020139a: `check()` now recognizes workflow definitions authored against the pre-rename SDK: `@sapiom/agent` exports `isLegacyOrchestrationDefinition`/`LEGACY_ORCHESTRATION_DEFINITION_BRAND` (the `Symbol.for('sapiom.orchestration.definition')` brand the old `defineOrchestration` attached), and `@sapiom/agent-core`'s `check()` accepts either brand in its export detection — the definition shape is unchanged by the rename, so manifests build identically. `check()` also gains a `typecheck` option (default `true`): pass `typecheck: false` to skip the project's `tsc --noEmit` when only the manifest/graph is needed (esbuild still surfaces bundle-level breakage).
- Updated dependencies [020139a]
  - @sapiom/agent@0.6.1

## 0.7.0

### Minor Changes

- 7a9d57a: Rename the execution-context field `ctx.workflowName` → `ctx.agentName`.

  **Breaking:** a step that reads `ctx.workflowName` must now read `ctx.agentName`. The value is unchanged — the agent's name (slug).

### Patch Changes

- Updated dependencies [7a9d57a]
  - @sapiom/agent@0.6.0
  - @sapiom/agent-runtime@0.3.1

## 0.6.0

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
  - @sapiom/agent-runtime@0.3.0
  - @sapiom/tools@0.16.0

## 0.5.0

### Minor Changes

- f2f4fec: Bring `inspect()` / `listExecutions()` to REST `ExecutionProjection` parity (tree + per-node cost + trace refs), replacing the flat inspection shape.

  **Breaking (return shapes):**

  - `inspect(opts, client)` now resolves the decoded `ExecutionProjection` **directly** (previously `{ execution }`). It carries the dispatch tree (`traceRoot`/`traceParent`/`traceId`/`spanId`, `parentExecutionId`/`rootExecutionId`, typed `children`), per-step `spanId`/`events`/`dispatch`, and a structured `StepError` (`trace` is now a `StepErrorTrace` of source-mapped frames, not a string).
  - `listExecutions(client)` now resolves `ExecutionRef[]` **directly** (previously `{ executions }`).
  - The flat `ExecutionDetail` / `StepRecord` types are removed; import the new projection types (`ExecutionProjection`, `StepProjection`, `CostNode`, `ExecutionRef`, `DispatchRef`, `StepError`, `StepEvent`) instead.

  **Cost is honest, never fabricated:** `cost` is `CostNode | null` at run and step granularity. The execution-detail read is cost-agnostic today (authoritative cost lives at `/executions/:id/spend`), so an absent cost decodes to `null`, not a misleading `$0`. `authorizedUsd`/`capturedUsd`/`settleState` are never collapsed when cost is present.

  The engine must emit the corresponding fields (per-node cost, list lineage, named child edges) for the projection to be fully populated; until then `inspect()`/`listExecutions()` degrade honestly rather than throwing. SDK pins move in lockstep with the engine.

## 0.4.5

### Patch Changes

- Updated dependencies [8fd3f71]
  - @sapiom/tools@0.15.0
  - @sapiom/orchestration@0.4.9

## 0.4.4

### Patch Changes

- Updated dependencies [aaf633c]
  - @sapiom/tools@0.14.0
  - @sapiom/orchestration@0.4.8

## 0.4.3

### Patch Changes

- Updated dependencies [cc2bde2]
  - @sapiom/tools@0.13.0
  - @sapiom/orchestration@0.4.7

## 0.4.2

### Patch Changes

- Updated dependencies [019ef30]
  - @sapiom/tools@0.12.0
  - @sapiom/orchestration@0.4.6

## 0.4.1

### Patch Changes

- Updated dependencies [84e44e2]
  - @sapiom/tools@0.11.0
  - @sapiom/orchestration@0.4.5

## 0.4.0

### Minor Changes

- ae1df3c: Scaffold honors `npm_config_registry` / `@scope:registry` when resolving the
  `@sapiom/*` versions to pin

  Version resolution previously hardcoded the public npm registry, so a scaffold
  always pinned public-npm `latest` even when the environment pointed at a
  different registry. It now resolves `latest` from the same registry a plain
  `npm install` would (a scoped `@<scope>:registry` wins over the global
  `npm_config_registry`, which wins over the public default). When that registry
  is non-default, the scaffolded project also gets a matching `.npmrc` so its
  pinned versions are installable. This makes a local registry dev loop work
  end-to-end with no manual pin edits; default scaffolds are unchanged.

### Patch Changes

- a85e665: Add schedules: run a deployed orchestration on a recurring cron schedule or once at a set time.

  - `@sapiom/orchestration-core`: `createSchedule`, `listSchedules`, `getSchedule`, `cancelSchedule`, and `previewCron`.
  - `@sapiom/tools`: a `schedules` namespace (`create`, `list`, `get`, `cancel`).
  - `@sapiom/cli`: `sapiom orchestrations schedule create | list | inspect | cancel | preview`.
  - `@sapiom/mcp`: schedule tools — create, inspect (list/detail + recent fires), cancel, and cron preview.

- Updated dependencies [a85e665]
  - @sapiom/tools@0.10.1

## 0.3.8

### Patch Changes

- Updated dependencies [6ebf569]
  - @sapiom/tools@0.10.0
  - @sapiom/orchestration@0.4.4

## 0.3.7

### Patch Changes

- 30bac1c: Improve the initial git + deploy experience for workflow authoring. Adds `bundleForDeploy` — a local, no-network bundler that inlines local/shared source and externalizes npm dependencies — and smooths first-time git init / deploy so a fresh workflow project deploys cleanly.

  ```ts
  import { bundleForDeploy } from "@sapiom/orchestration-core";

  const bundle = await bundleForDeploy(/* … */);
  ```

- Updated dependencies [30bac1c]
- Updated dependencies [30bac1c]
- Updated dependencies [0361fa7]
  - @sapiom/tools@0.9.0
  - @sapiom/orchestration@0.4.3

## 0.3.6

### Patch Changes

- Updated dependencies [2b94dff]
- Updated dependencies [ac71754]
- Updated dependencies [f078ed5]
  - @sapiom/tools@0.8.0
  - @sapiom/orchestration@0.4.2

## 0.3.5

### Patch Changes

- Updated dependencies [a3cc368]
  - @sapiom/tools@0.7.0
  - @sapiom/orchestration@0.4.1

## 0.3.4

### Patch Changes

- Updated dependencies [56fd77d]
  - @sapiom/orchestration@0.4.0
  - @sapiom/orchestration-runtime@0.2.2

## 0.3.3

### Patch Changes

- Updated dependencies [f41ab95]
  - @sapiom/orchestration@0.3.0
  - @sapiom/orchestration-runtime@0.2.1

## 0.3.2

### Patch Changes

- b2c5612: Move the orchestration authoring SDK onto zod 4 via the bare `zod` import (no
  more `zod/v4` subpath), so installing is just:

  ```sh
  npm install @sapiom/orchestration
  ```

  `zod` is now a regular dependency rather than a peer. Author your step schemas
  with your own `import { z } from "zod"` as usual; a compatibility re-export
  (`import { z } from "@sapiom/orchestration"`) is available for projects pinned
  to an incompatible zod. Scaffolded projects now pin zod 4.

- Updated dependencies [b2c5612]
- Updated dependencies [b2c5612]
  - @sapiom/orchestration@0.2.0
  - @sapiom/orchestration-runtime@0.2.0
  - @sapiom/tools@0.6.0

## 0.3.1

### Patch Changes

- Updated dependencies [5c974b1]
  - @sapiom/tools@0.5.0
  - @sapiom/orchestration@0.1.9

## 0.3.0

### Minor Changes

- e17b2d1: `scaffold` now initializes a git repository with an initial commit, so a freshly scaffolded project is immediately deployable (deploy requires a repo with at least one commit). Best-effort: if `git` is unavailable the project is left uninitialized. `ScaffoldResult` gains `gitInitialized`.

  Adds `waitForExecution` (and `isExecutionTerminal`) to poll an execution until it reaches a terminal state, settles on a pause that needs a signal, or a wait budget elapses — so callers don't hand-roll a poll loop. The `sapiom_dev_orchestrations_inspect` MCP tool gains opt-in `wait` / `maxWaitSeconds` options that use it and return `done` / `waiting` / `hint`; a non-blocking inspect of a still-running execution now also hints to use `wait`.

  Fixes `sapiom_dev_orchestrations_link`: omitting `name` no longer sends an empty name (which the gateway rejected). It now defaults to the orchestration's name read from `index.ts` (matching `defineOrchestration({ name })`), and returns a clear error if no name is available.

### Patch Changes

- e17b2d1: **BREAKING (`@sapiom/tools`):** align the coding-run resume payload with the shape a resumed step actually receives. `CodingResultPayload` now carries `executionEnvironment: { type, id } | null` instead of `sandbox: { name, workspaceRoot }`. Re-attach a resumed run's sandbox with `ctx.sapiom.sandboxes.attach(result.executionEnvironment.id)` (for a `blaxel_sandbox`).

  Adds `codingResultSchema` (runtime validation of the resume payload), `toResumePayload`, `ExecutionEnvironmentRef`, and `EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX`. The stub client now emits the same payload shape a resumed step receives, so a step written against the local loop runs identically once deployed.

  The `coding-pause` template and its guidance are updated to the new shape.

- Updated dependencies [e17b2d1]
  - @sapiom/tools@0.4.0
  - @sapiom/orchestration@0.1.8

## 0.2.0

### Minor Changes

- 704c9ac: Make the local development loop (`run_local`) production-faithful and trustworthy for the dispatch/pause pattern (`agent.coding.launch` + `pauseUntilSignal`).

  - Stub capability handles now survive JSON serialization, so a paused/resumed coding workflow runs end-to-end locally instead of failing with an opaque `'sandbox.toJSON' is not a method or field` error.
  - The payload a paused step resumes with is delivered as plain JSON — the same shape production sends over the wire — so authors re-attach handles by name (`sandboxes.attach(...)`) locally exactly as they would in prod.
  - `@sapiom/tools` exports `CodingResultPayload`: the shape a step resumed from `pauseUntilSignal(codingHandle, …)` receives, so resumed steps can be annotated instead of hand-rolling the type.
  - Stubbing a handle-returning capability with plain JSON no longer strips the handle's instance methods (e.g. `repo.pushFromSandbox`), and `repositories.list` stubs are coerced and shape-checked.
  - A dispatched `launch()` accepts the `agent.coding.launch` stub key as well as the shared `agent.coding.run` (ordered candidate resolution), so the stub key matching the call the author wrote takes effect.
  - `run_local` now reports `unusedStubs` (a supplied key that matched no call) and `stubWarnings` (a key that matched but carried the wrong shape), surfacing stubs that silently didn't take effect; the MCP `run_local` also serializes its result defensively.
  - New `coding-pause` scaffold template for the launch + pause + resume pattern, and AGENTS docs documenting the resume-input contract, list stub item shape, failure-branch stubbing, and step determinism under replay.

### Patch Changes

- Updated dependencies [704c9ac]
  - @sapiom/tools@0.3.0
  - @sapiom/orchestration@0.1.7

## 0.1.1

### Patch Changes

- Updated dependencies [7f6859e]
  - @sapiom/tools@0.2.0
  - @sapiom/orchestration@0.1.6
