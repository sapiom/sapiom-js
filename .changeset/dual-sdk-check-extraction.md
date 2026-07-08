---
"@sapiom/agent": patch
"@sapiom/agent-core": patch
---

`check()` now recognizes workflow definitions authored against the pre-rename SDK: `@sapiom/agent` exports `isLegacyOrchestrationDefinition`/`LEGACY_ORCHESTRATION_DEFINITION_BRAND` (the `Symbol.for('sapiom.orchestration.definition')` brand the old `defineOrchestration` attached), and `@sapiom/agent-core`'s `check()` accepts either brand in its export detection — the definition shape is unchanged by the rename, so manifests build identically. `check()` also gains a `typecheck` option (default `true`): pass `typecheck: false` to skip the project's `tsc --noEmit` when only the manifest/graph is needed (esbuild still surfaces bundle-level breakage).
