---
"@sapiom/langchain": minor
---

Emit metadata-only `model.call` / `tool.call` usage analytics from the middleware wrap hooks, with a structurally enforced privacy boundary.

- `wrapModelCall` / `wrapToolCall` now enqueue one `@sapiom/analytics-core` event per underlying invocation (`source: "langchain"`): model name, provider, duration, token counts when available, tool NAME, and success/error class. Emission is a synchronous enqueue that never throws or blocks, and ships dark unless an analytics endpoint is configured; `SAPIOM_TELEMETRY_DISABLED=1` / `DO_NOT_TRACK=1` opt out entirely.
- HARD EXCLUSIONS enforced structurally by an allow-list payload builder (not a redaction filter): no prompt text, no completions, no tool arguments, no tool results, no message content, no error messages — verified by sentinel-based redaction boundary tests against a mock collector.
- Realigned `langchain` dev/test tooling to the current 1.x line (`~1.5.3` + `@langchain/core ~1.2.1`) and adopted the `createMiddleware()` factory required by langchain 1.5 branded middleware types; public API and behavior unchanged.
- The `langchain` peer dependency floor is now ≥1.5.0 (`createMiddleware()` was introduced in 1.5; earlier versions fail at runtime).
