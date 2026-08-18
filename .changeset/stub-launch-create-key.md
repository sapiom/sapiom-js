---
"@sapiom/tools": patch
---

content-generation (stub): `images.launch` / `video.launch` now also honor the sync verb's override key (`contentGeneration.images.create` / `contentGeneration.video.create`), so a step that moves from `create()` to `launch()` — the documented fix for long-running fan-outs — keeps its stub instead of silently falling back to the built-in default. Precedence: `<ns>.launch` (the call you wrote) wins, then `<ns>.create`, then the legacy `<ns>.run` spelling, which stays honored for back-compat (contentGeneration has no `run` method, but the key resolved before this release). Internally the four inlined media stub payloads collapsed into shared `stubImageResult` / `stubVideoResult` factories, so the `create` and `launch` defaults can no longer drift apart.
