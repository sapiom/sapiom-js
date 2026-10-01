---
"@sapiom/tools": minor
"@sapiom/agent-core": patch
---

`@sapiom/tools`: new `events` capability. A step emits a tenant event with its own run
credential through `ctx.sapiom.events.emit({ type, payload, id? })` (also
`import { events } from "@sapiom/tools"`), which calls the gateway's
`POST /agents/v1/events` and resolves with the 202 receipt
`{ receiptId, outcome, duplicate, fireIds }`. Pass a stable `id` to make a retry safe.
The `run_local` stub answers `outcome: "unmatched"` unless overridden under `events.emit`.

`@sapiom/agent-core`: the authoring skill's trigger section names `ctx.sapiom.events.emit`.
