---
"@sapiom/tools": patch
"@sapiom/orchestration": patch
---

Add the dispatch→pause→resume authoring surface for long-running capabilities.

`@sapiom/tools`: new `DispatchHandle` contract + `CODING_RESULT_SIGNAL`; coding-run
handles now carry a `dispatch` member, and `launch` forwards the engine-injected
`SAPIOM_CAPABILITY_RESUME_TOKEN` as the `x-sapiom-workflow-token` header.

`@sapiom/orchestration`: `pauseUntilSignal` accepts a `DispatchHandle |
Promise<DispatchHandle>` so a step can pause on a launched capability with
`pauseUntilSignal(ctx.sapiom.agent.coding.launch(...), { resumeStep })`.

Additive and non-breaking — standalone `agent.coding.launch` is unchanged.
