---
"@sapiom/langchain-classic": minor
---

Emit metadata-only `model.call` / `tool.call` usage analytics from the classic wrappers, with a structurally enforced privacy boundary.

- `wrapSapiomTool` / `sapiomTool` / `SapiomDynamicTool` and the `SapiomChatOpenAI` / `SapiomChatAnthropic` model wrappers now enqueue one `@sapiom/analytics-core` event per underlying invocation (`source: "langchain"`): model name, provider, duration, token counts when available, tool NAME, and success/error class. Emission is a synchronous enqueue that never throws or blocks, and ships dark unless an analytics endpoint is configured; `SAPIOM_TELEMETRY_DISABLED=1` / `DO_NOT_TRACK=1` opt out entirely.
- HARD EXCLUSIONS enforced structurally by an allow-list payload builder (not a redaction filter): no prompt text, no completions, no tool arguments, no tool results, no schemas or descriptions, no message content, no error messages — verified by sentinel-based redaction boundary tests against a mock collector.
- Pinned `@langchain/openai` dev/test tooling to `~1.1.0` (the last line compatible with `@langchain/core` 0.3.x) so the package builds and tests under the current lockfile; public API and behavior unchanged.
- `@langchain/openai` (`~1.1.0`) and `@langchain/anthropic` (`^0.3.30`) are now declared as optional peer dependencies: the `SapiomChatOpenAI` / `SapiomChatAnthropic` wrappers import them directly, and the manifest previously omitted them. Marked optional so users of only one model family install nothing extra.
