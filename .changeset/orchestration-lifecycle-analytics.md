---
"@sapiom/agent-core": minor
"@sapiom/agent-runtime": minor
---

Emit workflow lifecycle usage analytics from the agent package family via `@sapiom/analytics-core` (source `"agent"`).

- `@sapiom/agent-core`: `link` / `deploy` / `run` emit one `workflow.link` / `workflow.deploy` / `workflow.run` event each, carrying metadata only — workflow name/id, duration, status, and a machine-readable error code on failure (never inputs, outputs, or error messages). The emitter is constructed lazily at the operation call boundary; `GatewayClient` stays env-free. `runLocal` emits the runtime's step lifecycle events flagged `local: true`.
- `@sapiom/agent-runtime`: `AgentRunnerCore` accepts an optional `analytics` sink (new `RuntimeAnalytics` host interface — a structural `track()` method, no new dependency) and emits `step.start` / `step.complete` / `step.error` with step name, attempt, and timing. No sink → no events, byte-for-byte previous behavior.

Telemetry ships dark: without a collector endpoint configured (`SAPIOM_ANALYTICS_ENDPOINT`) every `track` is a silent no-op — zero network calls, zero disk writes. Opt out any time with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`. Emission is synchronous enqueue-only and can never change an operation's behavior, results, or errors — collector outages included.
