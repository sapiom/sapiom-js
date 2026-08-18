---
"@sapiom/tools": patch
---

content-generation (stub): the `images.launch` / `video.launch` stubs no longer post-mutate `resolvedModel` onto the resolved result — it now lives inside the fallback factory, matching the `create` paths' override contract. Previously a frozen caller override under `contentGeneration.images.launch` / `contentGeneration.video.launch` (or their shared `.run` key) threw a `TypeError`, and a non-frozen one had its `resolvedModel` silently clobbered by `input.model ?? "stub-model"` with the caller's object mutated in place. Now a caller-supplied override wins verbatim and is never touched; the launch handle's required `resolvedModel` string falls back to `input.model ?? "stub-model"` when the override omits it.

Docs: the content-generation README's storage example uses `count` (not the deprecated `numImages`), its `VideoResultPayload` block now shows the `resolvedModel` / `cost` resume metadata and `downloadUrlUnavailable`, and the cost-envelope section documents `cost.reference` and the out-of-band settled amount (`GET /v1/transactions/:id/costs`). The 0.27.0 changelog entry retroactively documents the `VIDEO_MODELS` deprecation that shipped with the video repoint, and a customer name was removed from the shipped `MediaResumeFields` JSDoc.
