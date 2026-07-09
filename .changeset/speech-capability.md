---
"@sapiom/tools": minor
---

Add `speech` capability: text-to-speech, sound effect generation, and voice listing.

- `speech.tts.create({ text, voice?, storage?, params? })` — generate speech audio from text. Returns `url`, `expiresAt`, and `fileId` (when `storage` is passed).
- `speech.soundEffects.create({ text, durationSeconds?, storage?, params? })` — generate a sound effect from a text prompt.
- `speech.voices.list()` — list available voices (returns `voiceId` and `name` per entry).
- `SpeechHttpError` — error class (with `status` and `body`) thrown on non-2xx responses, re-exported from the barrel.
- Subpath export `@sapiom/tools/speech` available for direct imports.
- `storage` param on `tts.create` and `soundEffects.create` persists audio to Sapiom file storage; the result carries `fileId` for durable retrieval via `fileStorage.getDownloadUrl(fileId)`.
