---
"@sapiom/tools": minor
"@sapiom/agent-core": patch
---

Structured `llm.run` calls no longer fail silently when the token cap runs out before the answer (SAP-3280).

Thinking tokens are spent out of `request.max_tokens`. A routed label may emit a `thinking` block before the forced tool call, so a cap sized for the answer alone can be exhausted mid-deliberation: the turn ends before the tool call is ever emitted, `structuredOf` correctly returns `undefined`, and the step throws a `TypeError` from destructuring it. Deliberation is longest on the hardest, most ambiguous inputs, so an under-sized cap passes every test and every easy case and then drops exactly the item that was worth the most.

**`llm.run` now throws `LlmStructuredOutputTruncatedError`** when `output` was set and the turn stopped on `max_tokens` without a usable structured result — either no matching `tool_use` block came back (`reason: "no-tool-call"`) or the cap landed partway through the tool call, leaving an `input` that is empty or missing a field the schema requires (`reason: "incomplete-input"`). The reason union is exported as `LlmTruncationReason`. The error names the tool, the cap the request carried, and the fix, and carries the verbatim `response`. It is exported from `@sapiom/tools`.

Everything gated on that `stop_reason`, so nothing else changes: a truncated plain-text reply is still returned (it is readable, and bounding a reply on purpose is legitimate), an empty or partial structured result from a turn that ended any other way still reads as before, and a field the schema does not require is still the model's to omit.

**Breaking:** if you already handled the empty structured result yourself, wrap the call and catch `LlmStructuredOutputTruncatedError` — `error.response` is the verbatim response you used to receive.

**The examples now size the cap for thinking plus output.** The authoring skill's structured-output example and the `llm` JSDoc examples said `256` and `512`; every one now uses `4096` and says, next to the example, that thinking counts against the cap, that billing settles on the tokens actually produced, and that the cap is still not free — the gateway's admission weight scales with it. The skill also shows catching the error and `fail()`-ing the step, because the engine will otherwise retry the identical under-capped request.
