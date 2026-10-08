# speech

Text-to-speech, sound effects, and voice listing use the authenticated Core API:

| SDK method                                      | Core route (POST)                       |
| ----------------------------------------------- | --------------------------------------- |
| `textToSpeech.create()` / `createSpeech()`      | `/v1/capabilities/speech.tts`           |
| `soundEffects.create()` / `createSoundEffect()` | `/v1/capabilities/speech.sound-effects` |
| `voices.list()` / `listVoices()`                | `/v1/capabilities/speech.voices.list`   |

Core controls billing. Voice listing has no usage charge. The SDK sends the tenant
key and agent attribution with each request.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// Omit `voice` to use Core's default voice.
const result = await sapiom.speech.textToSpeech.create({
  text: "Hello, world!",
});
result.url;
result.expiresAt;

const sfx = await sapiom.speech.soundEffects.create({
  text: "thunder clap",
  durationSeconds: 3,
});
sfx.url;

const { voices } = await sapiom.speech.voices.list();
voices[0]?.voiceId;
voices[0]?.name;
```

The ambient import uses `SAPIOM_API_KEY`. In a managed step, use
`ctx.sapiom.speech` to keep the step's identity and attribution.

```typescript
import { speech } from "@sapiom/tools";
const result = await speech.textToSpeech.create({ text: "Hello, world!" });
```

## Core configuration

Speech uses the Core base URL like every routed capability (see
[`executions/README.md`](../executions/README.md)). It no longer reads
`SAPIOM_SPEECH_URL` or `SAPIOM_SERVICES_BASE`.

## Persist audio

Pass `storage` to save audio in Sapiom file storage. Core returns `fileId` when
storage succeeds. Use this ID to get a fresh download URL later.

```typescript
const result = await sapiom.speech.textToSpeech.create({
  text: "Hello, world!",
  storage: { visibility: "private" }, // or "public"
});
if (result.fileId) {
  const download = await sapiom.fileStorage.getDownloadUrl(result.fileId);
}
result.url; // Can be absent when Core returns only a stored file.
result.expiresAt;
result.storageError; // Present if storage failed; temporary audio can still be available.
```

Other response fields from Core pass through unchanged.

## Voices

`voices.list()` follows Core's page cursor and returns every available voice in
one list. If any page fails or Core repeats a cursor, it throws `SpeechHttpError`
instead of returning a partial list. Pass a voice's `voiceId` as `voice`; IDs are
forwarded unchanged and names are not resolved.

```typescript
const { voices } = await sapiom.speech.voices.list();
const myVoice = voices.find(
  (v) => v.name === "Sarah - Mature, Reassuring, Confident",
);
if (myVoice) {
  await sapiom.speech.textToSpeech.create({
    text: "Hello!",
    voice: myVoice.voiceId,
  });
}
```

## Provider options and request keys

`model` selects the provider model and its price class. It takes precedence over
the legacy `params.model_id`, and Core rejects unsupported models before billing.
Keep other provider options under `params`. Core validates them.

```typescript
await sapiom.speech.textToSpeech.create({
  text: "Hello!",
  model: "eleven_flash_v2_5",
  params: {
    voice_settings: { stability: 0.75, speed: 0.9 },
    output_format: "mp3_44100_128",
  },
});

await sapiom.speech.soundEffects.create({
  text: "rain on leaves",
  model: "eleven_text_to_sound_v2",
  durationSeconds: null,
  params: { duration_seconds: 4.5, prompt_influence: 0.3 },
});
```

A non-null `durationSeconds` takes precedence over `params.duration_seconds`.
Null or undefined preserves the provider option. If both durations are absent or
null, Core uses automatic duration. Provider options cannot replace the top-level
validated text or explicit storage choice.

TTS and sound effects accept an optional `idempotencyKey`, forwarded to Core
unchanged. Reusing a key returns its first successful result even if other fields
change, except that a different model is rejected. Use a new key for each new
request; a failed request can retry with the same key. The SDK never creates a key
or retries.

## Errors

HTTP failures throw `SpeechHttpError`. Its `status` and `body` contain the Core
HTTP status and parsed error body, or raw text. Missing credentials and network
failures throw the transport's own errors.

```typescript
import { SpeechHttpError } from "@sapiom/tools";
try {
  await sapiom.speech.textToSpeech.create({ text: "Hello!" });
} catch (err) {
  if (err instanceof SpeechHttpError) {
    console.error(err.status, err.body);
  }
}
```
