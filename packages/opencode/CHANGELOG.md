# @sapiom/opencode

## 0.1.0

### Minor Changes

- 175fe2b: Package a pinned headless OpenCode runtime and configure Sapiom access through Studio's private bridge.

### Patch Changes

- 2acd9bb: Attach a per-request completion instruction and support one durable native continuation from saved conversation results after an eligible incomplete turn. Fence prompt admission and uncertain dispatch, retain normal permissions, bound recovery time, and prevent the same continuation from dispatching again after reload. Preserve the exact Studio completion protocol on native compaction continuations so completed answers remain classifiable without replaying prompts or tool calls.
- 98f88fd: Isolate native OpenCode configuration discovery behind an ephemeral home and scrub runtime credentials from tool environments while preserving caller home-directory semantics.
- b04ad4d: Preserve MCP replay cursors and optional-stream protocol responses so queued tool results arrive without repeating the original tool call. Use the pinned OpenCode runtime's native Code Mode to retain full MCP discovery without sending every remote tool schema with each model request.
- d516895: Expose stable, retry-aware OpenCode startup failure codes without leaking native output, paths, configuration, or underlying causes.
- 1bb065e: Own OpenCode startup, authorized workspace state, access revocation, and shutdown in the shared Studio host.
- 7df16bd: Associate Studio sessions with distinct OpenCode conversations and expose authenticated, session-scoped actions and incremental events.
- a2ce646: Supervise native OpenCode process groups and publish cleanup proof only after owned runtime work is positively quiescent.
