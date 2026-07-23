# @sapiom/orchestration

## 0.6.7

### Patch Changes

- Updated dependencies [68d2352]
  - @sapiom/tools@0.22.0

## 0.6.6

### Patch Changes

- Updated dependencies [d00b9e3]
  - @sapiom/tools@0.21.0

## 0.6.5

### Patch Changes

- Updated dependencies [4cf0156]
  - @sapiom/tools@0.20.0

## 0.6.4

### Patch Changes

- Updated dependencies [e446a4a]
  - @sapiom/tools@0.19.0

## 0.6.3

### Patch Changes

- Updated dependencies [afc77e3]
  - @sapiom/tools@0.18.0

## 0.6.2

### Patch Changes

- Updated dependencies [aee376a]
  - @sapiom/tools@0.17.0

## 0.6.1

### Patch Changes

- 020139a: `check()` now recognizes workflow definitions authored against the pre-rename SDK: `@sapiom/agent` exports `isLegacyOrchestrationDefinition`/`LEGACY_ORCHESTRATION_DEFINITION_BRAND` (the `Symbol.for('sapiom.orchestration.definition')` brand the old `defineOrchestration` attached), and `@sapiom/agent-core`'s `check()` accepts either brand in its export detection — the definition shape is unchanged by the rename, so manifests build identically. `check()` also gains a `typecheck` option (default `true`): pass `typecheck: false` to skip the project's `tsc --noEmit` when only the manifest/graph is needed (esbuild still surfaces bundle-level breakage).

## 0.6.0

### Minor Changes

- 7a9d57a: Rename the execution-context field `ctx.workflowName` → `ctx.agentName`.

  **Breaking:** a step that reads `ctx.workflowName` must now read `ctx.agentName`. The value is unchanged — the agent's name (slug).

## 0.5.0

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
  - @sapiom/tools@0.16.0

## 0.4.9

### Patch Changes

- Updated dependencies [8fd3f71]
  - @sapiom/tools@0.15.0

## 0.4.8

### Patch Changes

- Updated dependencies [aaf633c]
  - @sapiom/tools@0.14.0

## 0.4.7

### Patch Changes

- Updated dependencies [cc2bde2]
  - @sapiom/tools@0.13.0

## 0.4.6

### Patch Changes

- Updated dependencies [019ef30]
  - @sapiom/tools@0.12.0

## 0.4.5

### Patch Changes

- Updated dependencies [84e44e2]
  - @sapiom/tools@0.11.0

## 0.4.4

### Patch Changes

- Updated dependencies [6ebf569]
  - @sapiom/tools@0.10.0

## 0.4.3

### Patch Changes

- Updated dependencies [30bac1c]
- Updated dependencies [30bac1c]
- Updated dependencies [0361fa7]
  - @sapiom/tools@0.9.0

## 0.4.2

### Patch Changes

- Updated dependencies [2b94dff]
- Updated dependencies [ac71754]
- Updated dependencies [f078ed5]
  - @sapiom/tools@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [a3cc368]
  - @sapiom/tools@0.7.0

## 0.4.0

### Minor Changes

- 56fd77d: Broaden `zod` peer support to `^3.25.76 || ^4.0.0` (was `^4.0.0`).

  The package now uses zod's v4 API via the `zod/v4` subpath internally (types, `z.toJSONSchema`) instead of importing from `zod` directly. That subpath ships in **both** zod 3.25.x and zod 4.x, so the package can be consumed on either — restoring support for zod-3.25 projects (which `^4.0.0` had excluded) while keeping zod 4 working. Author step schemas with `import { z } from "zod/v4"` (equivalent to `import { z } from "zod"` on zod 4).

  Non-breaking for existing zod-4 consumers: `zod/v4` and `zod` resolve to the same v4 implementation there.

## 0.3.0

### Minor Changes

- f41ab95: Declare `zod` as a `peerDependency` (`^4.0.0`) instead of a direct dependency, and remove the `z` / `ZodType` compatibility re-exports from the package entry.

  Step `inputSchema`s are zod schemas authored in the consumer's project and passed into this package, so there must be a single shared `zod` instance — bundling our own copy could otherwise cause type and `instanceof` mismatches against the consumer's `zod`. zod 4 is required; npm 7+ and pnpm install the peer automatically (consumers on older package managers should add `zod` alongside this package).

  The previous `export { z } from "zod"` shim only worked because the package bundled its own `zod`; with `zod` as a peer it would just re-export the consumer's own instance, so it has been removed. Import `z` from `zod` directly.

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
  - @sapiom/tools@0.6.0

## 0.1.9

### Patch Changes

- Updated dependencies [5c974b1]
  - @sapiom/tools@0.5.0

## 0.1.8

### Patch Changes

- Updated dependencies [e17b2d1]
  - @sapiom/tools@0.4.0

## 0.1.7

### Patch Changes

- Updated dependencies [704c9ac]
  - @sapiom/tools@0.3.0

## 0.1.6

### Patch Changes

- Updated dependencies [7f6859e]
  - @sapiom/tools@0.2.0

## 0.1.5

### Patch Changes

- 363270f: Generated step-input JSON Schemas no longer reject fields the schema doesn't declare.

  `z.toJSONSchema()` (Zod v4) marks every object as closed (`additionalProperties: false`), but a `z.object()` ignores keys it doesn't name when it parses, rather than rejecting them. `buildManifest` now strips the closed-object marker from the schemas it emits so the two behaviors match — a step keeps validating successfully when an input it receives carries extra fields the step's `inputSchema` doesn't name. Typed catchalls (`z.object().catchall(...)`) are preserved.

  Additive and non-breaking. If you previously added fields to a step's `inputSchema` only to admit extra incoming payload fields, that workaround is no longer required (though it remains harmless).

## 0.1.4

### Patch Changes

- 2f957ca: Depend on `@sapiom/tools` with a caret range (`^0.1`) instead of an exact
  version. The dependency was declared `workspace:*`, which publishes as the exact
  resolved version — so `@sapiom/orchestration@0.1.2` carried a hard `0.1.2` pin and
  forced a second copy of `@sapiom/tools` whenever a project used a newer patch
  (e.g. tools `0.1.3`), producing duplicate nominal types and `tsc` errors. A caret
  range lets the consumer's own `@sapiom/tools` (any `0.1.x`) satisfy and dedupe to
  a single copy, while still pulling tools in transitively so authoring types
  resolve out of the box.

## 0.1.3

### Patch Changes

- Updated dependencies [2126d96]
  - @sapiom/tools@0.1.3

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

- Updated dependencies [be3886e]
  - @sapiom/tools@0.1.2
