# @sapiom/orchestration-runtime

## 0.4.0

### Minor Changes

- d661d57: Emit workflow lifecycle usage analytics from the agent package family via `@sapiom/analytics-core` (source `"agent"`).

  - `@sapiom/agent-core`: `link` / `deploy` / `run` emit one `workflow.link` / `workflow.deploy` / `workflow.run` event each, carrying metadata only — workflow name/id, duration, status, and a machine-readable error code on failure (never inputs, outputs, or error messages). The emitter is constructed lazily at the operation call boundary; `GatewayClient` stays env-free. `runLocal` emits the runtime's step lifecycle events flagged `local: true`.
  - `@sapiom/agent-runtime`: `AgentRunnerCore` accepts an optional `analytics` sink (new `RuntimeAnalytics` host interface — a structural `track()` method, no new dependency) and emits `step.start` / `step.complete` / `step.error` with step name, attempt, and timing. No sink → no events, byte-for-byte previous behavior.

  Telemetry ships dark: without a collector endpoint configured (`SAPIOM_ANALYTICS_ENDPOINT`) every `track` is a silent no-op — zero network calls, zero disk writes. Opt out any time with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`. Emission is synchronous enqueue-only and can never change an operation's behavior, results, or errors — collector outages included.

### Patch Changes

- @sapiom/agent@0.6.2

## 0.3.1

### Patch Changes

- Updated dependencies [7a9d57a]
  - @sapiom/agent@0.6.0

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

## 0.2.2

### Patch Changes

- Updated dependencies [56fd77d]
  - @sapiom/orchestration@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [f41ab95]
  - @sapiom/orchestration@0.3.0

## 0.2.0

### Minor Changes

- b2c5612: Move the orchestration authoring SDK onto zod 4 via the bare `zod` import (no
  more `zod/v4` subpath), so installing is just:

  ```sh
  npm install @sapiom/orchestration
  ```

  `zod` is now a regular dependency rather than a peer. Author your step schemas
  with your own `import { z } from "zod"` as usual; a compatibility re-export
  (`import { z } from "@sapiom/orchestration"`) is available for projects pinned
  to an incompatible zod. Scaffolded projects now pin zod 4.

### Patch Changes

- Updated dependencies [b2c5612]
  - @sapiom/orchestration@0.2.0
