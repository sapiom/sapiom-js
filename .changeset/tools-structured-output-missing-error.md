---
"@sapiom/tools": minor
---

`llm.run` with `output` now throws `LlmStructuredOutputMissingError` when the turn ends without a `tool_use` block for `output.name` (for example `stop_reason: "end_turn"` with only `thinking` and `text` blocks). Previously it returned the response and `structuredOf` read `undefined`, so a step could proceed with no result (SAP-3782). The error carries `outputName`, `stopReason`, `servedClass`, `model`, `blockTypes` and the raw `response`. The `max_tokens` case still throws `LlmStructuredOutputTruncatedError`, and `structuredOf` still returns `undefined` for a response with no matching block. Callers that checked `structuredOf(...) === undefined` after `llm.run({ output })` to retry or degrade must now catch the new error instead.
