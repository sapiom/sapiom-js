# @sapiom/orchestration

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
