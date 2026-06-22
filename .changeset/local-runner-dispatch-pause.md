---
"@sapiom/tools": minor
"@sapiom/orchestration-core": minor
"@sapiom/mcp": patch
---

Make the local development loop (`run_local`) production-faithful and trustworthy for the dispatch/pause pattern (`agent.coding.launch` + `pauseUntilSignal`).

- Stub capability handles now survive JSON serialization, so a paused/resumed coding workflow runs end-to-end locally instead of failing with an opaque `'sandbox.toJSON' is not a method or field` error.
- The payload a paused step resumes with is delivered as plain JSON — the same shape production sends over the wire — so authors re-attach handles by name (`sandboxes.attach(...)`) locally exactly as they would in prod.
- `@sapiom/tools` exports `CodingResultPayload`: the shape a step resumed from `pauseUntilSignal(codingHandle, …)` receives, so resumed steps can be annotated instead of hand-rolling the type.
- Stubbing a handle-returning capability with plain JSON no longer strips the handle's instance methods (e.g. `repo.pushFromSandbox`), and `repositories.list` stubs are coerced and shape-checked.
- A dispatched `launch()` accepts the `agent.coding.launch` stub key as well as the shared `agent.coding.run` (ordered candidate resolution), so the stub key matching the call the author wrote takes effect.
- `run_local` now reports `unusedStubs` (a supplied key that matched no call) and `stubWarnings` (a key that matched but carried the wrong shape), surfacing stubs that silently didn't take effect; the MCP `run_local` also serializes its result defensively.
- New `coding-pause` scaffold template for the launch + pause + resume pattern, and AGENTS docs documenting the resume-input contract, list stub item shape, failure-branch stubbing, and step determinism under replay.
