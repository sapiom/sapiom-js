# speech

Text-to-speech, sound effect generation, and voice listing. The same speech
capability your agents call over MCP, callable directly from your code.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// 1. Generate speech from text.
const result = await sapiom.speech.tts.create({
  text: "Hello, world!",
  voice: "Aria",          // optional — defaults to a standard voice
});
result.url;               // hosted audio URL

// 2. Generate a sound effect from a text prompt.
const sfx = await sapiom.speech.soundEffects.create({
  text: "thunder clap",
  durationSeconds: 3,     // optional
});
sfx.url;                  // hosted audio URL

// 3. List available voices.
const { voices } = await sapiom.speech.voices.list();
voices[0]?.voiceId;       // pass this as `voice` to tts.create
voices[0]?.name;
```

Ambient import works too:

```typescript
import { speech } from "@sapiom/tools";
const result = await speech.tts.create({ text: "Hello, world!" });
```

## Persisting audio with file storage

Pass `storage` to persist the generated audio to Sapiom file storage. The
result then carries a `fileId` you can use to retrieve the file later via
`fileStorage.getDownloadUrl(fileId)`.

```typescript
const result = await sapiom.speech.tts.create({
  text: "Hello, world!",
  storage: { visibility: "private" }, // or "public"
});
result.fileId;     // durable file id → use with fileStorage.getDownloadUrl
result.url;        // short-lived hosted URL (still present)
result.expiresAt;  // when `url` expires

// If persisting to storage fails (e.g. quota), the audio is still returned:
result.storageError; // describes the failure; url is still usable
```

## Voices

`voices.list()` returns the full catalog of voices available to your account.
Pass the `voiceId` (or name) to `tts.create({ voice })` to choose one.

```typescript
const { voices } = await sapiom.speech.voices.list();
const myVoice = voices.find((v) => v.name === "Rachel");
if (myVoice) {
  const result = await sapiom.speech.tts.create({
    text: "Hello from Rachel!",
    voice: myVoice.voiceId,
  });
}
```

## Advanced parameters

Both `tts.create` and `soundEffects.create` accept a `params` object that is
forwarded verbatim to the underlying capability (e.g. `stability`, `speed`, `seed`).

```typescript
const result = await sapiom.speech.tts.create({
  text: "Hello!",
  params: { stability: 0.75, speed: 0.9 },
});
```

## Error handling

Failed requests throw `SpeechHttpError` (carries `status` + parsed `body`),
exported from `@sapiom/tools`.

```typescript
import { SpeechHttpError } from "@sapiom/tools";

try {
  await sapiom.speech.tts.create({ text: "Hello!" });
} catch (err) {
  if (err instanceof SpeechHttpError) {
    console.error(err.status, err.body);
  }
}
```
