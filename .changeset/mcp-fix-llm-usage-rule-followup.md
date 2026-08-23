---
"@sapiom/mcp": patch
---

`AUTHORING_INSTRUCTIONS`'s "Calling LLMs and running agent loops" section, three fixes: (1) scoped the "reports the served class and lane on the result" claim — `models.coding.run` reports both as `null` today, and older servers omit the fields entirely (treat missing as unknown); (2) dropped "If you must pin, use the `smart` label" — `smart` is already the default (a no-op instruction), and on the sessions surface `model` pins an exact alias rather than a label, so the advice was wrong-field there too; (3) the structured-output line now says the `output` param forces a tool call, so the payload is always the `tool_use` block's `input` — one mechanism, not two. Kept byte-identical to the corresponding fix landing in the companion Sapiom-repo PR.
