---
"@sapiom/tools": minor
---

Execution results now expose the server's serving disclosure, in SKU vocabulary — plus structured-output and routing-label ergonomics for `llm.run`. Reissues #673 under the corrected SAP-2764 contract (`servedClass`/`lane`, not the earlier draft's `servedModel`/provider `costUsd`).

- `models.run` (`ModelRunOutcome`) and `models.coding.run` (`CodingRunOutcome`): new optional `servedClass` + `lane` (wire `served_class`, `lane`) — the billing class (size) the run's label resolved to and the lane it executed in. Never a model or provider id. `undefined`/`null` on older servers or when coding cannot observe it — never fabricated.
- `llm.run` / `llm.redeem` / `llm.callSession`: new `LlmDisclosure` type describing the `served_class` / `lane` fields the server injects top-level into raw `/v2` non-streaming response bodies, plus a `readDisclosure()` helper returning the camel-cased `LlmDisclosureResult`. The response `model` field is unchanged and keeps echoing the requested label.
- `llm.run` gains an optional `output: { name, schema }` field — the blessed tool-calling pattern for structured output, automated: it appends a forced tool call to the request and forces `tool_choice` onto it. `run`'s return type is unchanged either way (still the verbatim response); read the parsed value with the new `structuredOf()` helper. A new `textOf()` helper reads the plain-text reply, correctly skipping a `thinking` block that may precede it.
- `model`/`label` fields across `llm.run`, `llm.submit`, `llm.createSession`, `models.run`, and `models.coding.run` are now typed as a soft union (`"smart" | (string & {})`, lint-safely spelled) for autocomplete, with JSDoc settled on "routing label" terminology: omit to let the platform choose, `"smart"` if you must pin, a raw provider model id is never honored.

All additions are optional: existing consumers compile and run unchanged. On results from older servers the mappers and `readDisclosure` return `servedClass`/`lane` as `null` (unknown).
