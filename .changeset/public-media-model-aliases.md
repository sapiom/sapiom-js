---
"@sapiom/tools": minor
---

`contentGeneration` gains public model-alias maps and `select`, the capability-based model chooser.

New `IMAGE_MODELS` / `VIDEO_MODEL_ALIASES` maps (plus the `KnownImageModel` / `KnownVideoModelAlias` types) carry the public semantic model aliases — `"flux-fast"`, `"veo3-fast"`, … — which are the supported input for `model`. `ImageCreateInput.model` is retyped from bare `string` to `LiteralUnion<KnownImageModel>` for editor autocomplete.

**Non-breaking.** Both `model` fields stay literal-union-widened to `string`, so an existing raw-provider-id pin keeps compiling and keeps working, and a newly-cataloged alias works before the SDK catches up. No client-side validation is added — the platform catalog stays the authority. Raw provider ids (and the `VIDEO_MODELS` map that lists them) are now documented as **deprecated**: still supported today, to be removed in a future release.

New optional `select` on both image and video inputs, forwarded on the request body only when set and honored when `model` is omitted. It is typed per media type: `VideoSelect` accepts `requires: ("audio" | "lipsync" | "referenceImage")[]`, `ImageSelect` accepts no `requires` at all (no image model declares a capability tag, so the option could only narrow to zero candidates), and both accept `prefer: "cheapest"`. Asking an image call for `requires` is therefore a compile error rather than a request that can only fail. `MediaSelect` is exported as the union of the two and is accepted by both inputs, for code generic over image and video. The response (and both launch handles) now type `preferSatisfied` alongside `resolvedModel`; for the async paths it is threaded from the submit handle, and it is omitted entirely unless a preference was requested.
