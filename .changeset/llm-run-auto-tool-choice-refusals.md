---
"@sapiom/tools": minor
---

`llm.run({ output })` no longer forces `tool_choice`. Current Claude models (Opus 5.5,
Sonnet 5.5, Fable 5.1) reject a forced `tool_choice` with a 400, so the structured-output
tool is now offered under `tool_choice: { type: "auto" }` and requested by one line
appended to the system prompt. A turn that answers without calling it still throws
`LlmStructuredOutputMissingError`.

`llm.run` now throws `LlmRefusalError` when the response's `stop_reason` is `"refusal"`,
instead of returning the declined turn as an answer. It carries `category` and
`explanation` from `stop_details`. `ModelRunSpec.maxTokens` now documents that the cap
covers thinking as well as output.
