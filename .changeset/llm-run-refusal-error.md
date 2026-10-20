---
"@sapiom/tools": minor
---

`llm.run` now throws `LlmRefusalError` when the response's `stop_reason` is `"refusal"`,
instead of returning the declined turn as an answer. It carries `category` and
`explanation` from `stop_details`. `ModelRunSpec.maxTokens` now documents that the cap
covers thinking as well as output.
