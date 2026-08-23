---
"@sapiom/mcp": patch
---

`AUTHORING_INSTRUCTIONS`'s "Calling LLMs and running agent loops" section: scoped the "reports the served class and lane on the result" claim so it doesn't imply `models.coding.run` returns them too — that surface reports both as `null` today. Also dropped "If you must pin, use the `smart` label" — `smart` is already the default (a no-op instruction), and on the sessions surface `model` pins an exact alias rather than a label, so the advice was wrong-field there too. Kept byte-identical to the corresponding fix landing in the companion Sapiom-repo PR.
