---
"@sapiom/tools": patch
---

Forward the workflow resume token explicitly via `createClient({ resumeToken })`.

`agent.coding.run`/`launch` send the per-execution resume token as the `x-sapiom-workflow-token` header so the gateway can resume the paused workflow step. Previously the token was read ONLY from `process.env.SAPIOM_CAPABILITY_RESUME_TOKEN` — fine for the sandbox runtime (which injects that env var) but invisible to the engine's in-process runtime, which must not set process-global env (it would bleed across concurrent step executions sharing the worker). `TransportConfig` now accepts an optional `resumeToken`; the client prefers it and falls back to the env var, so the sandbox path is unchanged and the in-process runtime can pass the token per-call. Additive and backward-compatible.
