---
"@sapiom/tools": patch
---

The local `llm.run` stub now honors `LlmRunSpec.output`.

`output` forces a tool call on the real surface, so a stub that always answered with a text block made `structuredOf` read `undefined` under `run_local` for code that gets a value in production. Any step that (rightly) refuses to invent a value therefore failed locally for the wrong reason. The stub now returns a `tool_use` block named after `output.name`, carrying a minimal placeholder built from `output.schema` — required properties only, one element per array, the first `enum` member. A step that branches on the actual value should still override `llm.run` in its stub file.
