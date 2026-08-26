---
"@sapiom/tools": patch
---

Two `run_local` stub fixes, both needed for a template that reads structured output to trace its graph locally.

**`llm.run` now honors `LlmRunSpec.output`.** `output` forces a tool call on the real surface, so a stub that always answered with a text block made `structuredOf` read `undefined` under `run_local` for code that gets a value in production. Any step that (rightly) refuses to invent a value therefore failed locally for the wrong reason. The stub now returns a `tool_use` block named after `output.name`, carrying a minimal placeholder built from `output.schema` — required properties only, one element per array, the first `enum` member, `minimum`/`minItems` respected. A step that branches on the actual value should still override `llm.run` in its stub file.

**Sandbox handle methods that returned nothing now return their real shape.** `deployPreview`, `createPublicUrl`, `uploadFile` and `uploadDir` had no stub default, so an unoverridden call resolved to `undefined` and the caller dereferenced it — `deployPreview(...).status` threw `Cannot read properties of undefined` rather than reporting a missing stub. These are the handle methods `examples/` actually calls.
