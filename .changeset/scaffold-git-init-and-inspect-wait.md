---
"@sapiom/orchestration-core": minor
"@sapiom/mcp": minor
---

`scaffold` now initializes a git repository with an initial commit, so a freshly scaffolded project is immediately deployable (deploy requires a repo with at least one commit). Best-effort: if `git` is unavailable the project is left uninitialized. `ScaffoldResult` gains `gitInitialized`.

Adds `waitForExecution` (and `isExecutionTerminal`) to poll an execution until it reaches a terminal state, settles on a pause that needs a signal, or a wait budget elapses — so callers don't hand-roll a poll loop. The `sapiom_dev_orchestrations_inspect` MCP tool gains opt-in `wait` / `maxWaitSeconds` options that use it and return `done` / `waiting` / `hint`; a non-blocking inspect of a still-running execution now also hints to use `wait`.

Fixes `sapiom_dev_orchestrations_link`: omitting `name` no longer sends an empty name (which the gateway rejected). It now defaults to the orchestration's name read from `index.ts` (matching `defineOrchestration({ name })`), and returns a clear error if no name is available.
