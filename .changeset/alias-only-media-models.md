---
"@sapiom/tools": minor
---

`contentGeneration` model selectors are now alias-only, and `select` lets the platform pick the model.

The routed image and video capabilities accept a **public semantic alias** (`"flux-fast"`, `"veo3-fast"`) and reject a raw provider model id with `400 unknown_model`. New `IMAGE_MODELS` / `VIDEO_MODEL_ALIASES` maps (plus the `KnownImageModel` / `KnownVideoModelAlias` types) carry those aliases for autocomplete; both stay literal-union-widened-to-`string`, so a newly-cataloged alias works before the SDK catches up and no client-side validation can block one. `ImageCreateInput.model` is retyped from bare `string` and no longer documents raw provider ids as supported. `VIDEO_MODELS` (raw `fal-ai/…` ids) keeps working and stays exported, but its deprecation notice now names the coming rejection and the per-entry migration.

New optional `select` on both image and video inputs — `{ requires?: ("audio" | "lipsync" | "referenceImage")[]; prefer?: "cheapest" }` — forwarded on the request body only when set, honored when `model` is omitted. The response (and both launch handles) now type `preferSatisfied` alongside `resolvedModel`; for the async paths it is threaded from the submit handle, and it is omitted entirely unless a preference was requested.
