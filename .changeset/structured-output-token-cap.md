---
"@sapiom/tools": minor
"@sapiom/agent-core": patch
---

Structured `llm.run` calls no longer fail silently when the token cap runs out before the answer (SAP-3280).

Thinking tokens are spent out of `request.max_tokens`. A routed label may emit a `thinking` block before the forced tool call, so a cap sized for the answer alone can be exhausted mid-deliberation: the turn ends before the tool call is ever emitted, `structuredOf` correctly returns `undefined`, and the step throws a `TypeError` from destructuring it. Deliberation is longest on the hardest, most ambiguous inputs, so an under-sized cap passes every test and every easy case and then drops exactly the item that was worth the most.

**`llm.run` now throws `LlmStructuredOutputTruncatedError`** in that one unambiguous case — `output` was set, the turn stopped on `max_tokens`, and no matching `tool_use` block came back — instead of returning a response no structured reader can make sense of. The error names the tool, the cap the request carried, and the fix, and carries the verbatim `response` for inspection. It is exported from `@sapiom/tools`. Nothing else changes: a truncated plain-text reply is still returned (it is readable, and bounding a reply on purpose is legitimate), and an empty structured result that was not truncated still reads as `undefined`.

**The examples now size the cap for thinking plus output.** The authoring skill's structured-output example and the `llm` JSDoc examples said `256` and `512`; every one now uses `4096` and says, next to the example, that thinking counts against the cap and that the cap is a ceiling rather than a reservation — billing settles on the tokens actually produced, so headroom on a short reply costs nothing.
