# @sapiom/orchestration-runtime

## 0.7.0

### Minor Changes

- 555475d: Make `ctx.shared.set()` on the SDK's `InMemoryContextStore` an atomic
  whole-snapshot quota gate. `runLocal` now constructs this store with step
  context; hosts that have not adopted this store version may enforce the contract
  only at execution boundaries during rollout. The store measures the complete
  candidate as compact JSON UTF-8 before committing it, so oversized writes throw
  `CTX_SHARED_SIZE_LIMIT_EXCEEDED` and retain the previous state.

  Publish the bounded `CTX_SHARED_SERIALIZATION_FAILED` terminal error contract
  for circular references, BigInt values, throwing `toJSON` methods, and other
  `JSON.stringify` failures. Completion serializers and runners recognize the
  new code through the closed platform-error registry and fail the step on its
  current attempt without retrying. Ordinary JSON omission and coercion semantics
  remain unchanged.

  **Breaking:** `InMemoryContextStore.set()` can now throw synchronously for an
  oversized or unserializable candidate. Existing local agents that wrote such
  state now fail non-retryably on attempt 0. Migrate bulk state to durable storage
  and keep only compact, JSON-compatible values or references in `ctx.shared`. If
  a store is seeded with legacy invalid state, replace an offending key with a
  value small enough to bring the complete candidate within the quota;
  `TypedContextStore` has no `delete()` operation.

### Patch Changes

- Updated dependencies [555475d]
  - @sapiom/agent@0.12.0

## 0.6.0

### Minor Changes

- 9afeda9: Add a closed, versioned retry-classification contract for platform-owned step
  errors. `CTX_SHARED_SIZE_LIMIT_EXCEEDED` and
  `STEP_INPUT_VALIDATION_FAILED` now settle executions terminally without
  consuming workflow retries; unknown, author, and capability errors keep the
  legacy retry behavior.

  `StepInputValidationError` now exposes a dedicated bounded wire payload with
  stable `code`, `version`, `stepName`, and `retryable: false` fields while its
  ordinary JSON representation continues carrying raw Zod issues for in-process
  callers. Hosts receive a normalizing `parseNonRetryableStepErrorPayload`
  registry plus `serializeStepCompletionError()` for completion reporters, and
  may implement the additive atomic active-dispatch failure capability required
  for terminal settlement. Older stores omit that capability and retain the
  legacy retry path.

### Patch Changes

- Updated dependencies [9afeda9]
  - @sapiom/agent@0.11.0

## 0.5.0

### Minor Changes

- af764cd: Publish the authoritative 256 KiB `ctx.shared` whole-snapshot contract from
  `@sapiom/agent`: `CTX_SHARED_QUOTA_CONTRACT`,
  `MAX_SHARED_SNAPSHOT_BYTES`, `measureCtxSharedSnapshotBytes`,
  `findCtxSharedSizeViolation`, `CtxSharedSizeLimitExceededError`,
  `ctxSharedSizeLimitExceededPayloadSchema`, and
  `isCtxSharedSizeLimitExceededPayload`, plus the
  `CtxSharedSizeLimitPhase`, `CtxSharedSizeViolation`,
  `CtxSharedSizeLimitExceededPayload`, and
  `CtxSharedSizeLimitExceededErrorOptions` types.

  `@sapiom/agent-runtime` now publicly exports `stepCompletionErrorSchema`,
  preserves compatible structured quota payloads through protocol-1 parsing, and
  re-exports the canonical compatibility limit.

  Structured quota payloads include the reporting contract `version` and retain
  unknown non-empty future phases during mixed-version rollouts; current error
  construction remains limited to the three published enforcement phases.

  This release defines measurement and error contracts; it does not make
  `ctx.shared.set()` an atomic size gate or add local/final host-boundary
  enforcement by itself. Host versions must adopt the contract. Authoring skills,
  scaffolds, and MCP guidance now document compact ID/reference usage and that
  enforcement can vary during rollout.

### Patch Changes

- Updated dependencies [af764cd]
  - @sapiom/agent@0.10.0

## 0.4.3

### Patch Changes

- Updated dependencies [c8072cd]
  - @sapiom/agent@0.9.0

## 0.4.2

### Patch Changes

- Updated dependencies [a1e0e4f]
  - @sapiom/agent@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [3f96e37]
  - @sapiom/agent@0.7.0

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
