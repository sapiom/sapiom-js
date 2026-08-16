---
"@sapiom/tools": patch
---

content-generation (stub): the offline `contentGeneration.images.create` and `video.create` stubs now
return `resolvedModel`, matching the required `ImageGenerationResult` / `VideoGenerationResult` type and
the real routed backend (which always echoes it). Previously the sync `create` stubs omitted the field
behind an `as …Result` cast, so code reading `result.resolvedModel` under the stub got `undefined` while
the type promised a `string`. The `launch` stubs already set it; this brings `create` in line
(`input.model ?? "stub-model"`).
