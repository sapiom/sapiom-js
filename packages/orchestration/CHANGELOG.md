# @sapiom/orchestration

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
