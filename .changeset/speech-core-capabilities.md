---
"@sapiom/tools": minor
---

Route text-to-speech, sound effects, and voice listing through the authenticated
Core capability API. Method names and TTS and sound-effect result fields are
unchanged; TTS and sound effects gain optional `model` and `idempotencyKey`
fields. The voice-list result changes as described below.

**Breaking — speech moves to Core and takes voice IDs only.**

- Explicit `voice` values must be provider voice IDs (names are not resolved) and
  are forwarded unchanged. Omit `voice` to use Core's default.
- The exported `DEFAULT_VOICE` now contains Rachel's provider ID,
  `21m00Tcm4TlvDq8ikWAM`, instead of `"Rachel"`, and is deprecated because Core
  owns the default.
- `speech.voices.list()` now follows Core's `nextCursor` and returns every voice.
  The result no longer includes `has_more`, `next_page_token`, or `total_count`,
  and `VoicesResult` no longer accepts extra fields. A failed page or a repeated
  cursor throws instead of returning a partial list.
- Configure Core with `coreBaseUrl`, `SAPIOM_BASE_URL`, or `SAPIOM_API_URL`; these
  speech methods no longer read `SAPIOM_SPEECH_URL`.

Requires deployed SAP-3283: Sapiom #5178–#5182, plus #5590 for the voice-list
cursor. Without #5590, `voices.list()` returns only the first page. Older SDK
versions still require the legacy gateway.
