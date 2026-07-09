---
"@sapiom/mcp": minor
---

Emit anonymous `tool.call` usage analytics from the MCP server via `@sapiom/analytics-core`: every tool invocation records the tool name, its arguments (size-capped), duration, and ok/error class. The emitter ships dark — with no collector endpoint configured (`SAPIOM_ANALYTICS_ENDPOINT`), nothing is sent anywhere and nothing is written to disk — and honors the standard opt-outs (`SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`). Emission is a synchronous in-memory enqueue off the tool hot path and can never change a tool result: a collector that is down, slow, or erroring is invisible to tool callers.
