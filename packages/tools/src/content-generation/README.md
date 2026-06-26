# contentGeneration

Generate media — images and video today (audio to come) — with an optional
`storage` param that persists each output to Sapiom file storage, so you get a
durable `fileId` back inline.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const out = await sapiom.contentGeneration.images.create({
  prompt: "a red bicycle",
  storage: { visibility: "private" }, // optional — persist outputs to file storage
});

out.images[0].url; // hosted URL of the generated image
out.images[0].fileId; // present when `storage` was passed — use with `fileStorage`
```

Ambient import works too: `import { contentGeneration } from "@sapiom/tools"`.

## The optional `storage` param

Pass `storage` and each generated output is persisted to your tenant's file
storage as it returns — no extra round-trip. Each item in `images` is then
annotated with its own `fileId`:

```typescript
const out = await sapiom.contentGeneration.images.create({
  prompt: "four color swatches",
  numImages: 4,
  storage: { visibility: "public" },
});
for (const img of out.images ?? []) {
  if (img.fileId) {
    const { downloadUrl } = await sapiom.fileStorage.getDownloadUrl(img.fileId);
  }
}
```

Persisting is best-effort per image: if one fails, that image carries a
`storageError` string instead of a `fileId` while the others still succeed.

## Video (async)

Video generation is **asynchronous** — `create` submits the job, polls for the
result, and resolves once it's ready, so you `await` it like an image (it just
takes longer). `storage` works the same way — the output comes back with a `fileId`.

```typescript
const out = await sapiom.contentGeneration.video.create({
  prompt: "a calm ocean wave at sunset",
  storage: { visibility: "private" }, // optional — persist the output
});

out.video?.url; // hosted URL of the generated video
out.video?.fileId; // present when `storage` was passed — use with `fileStorage`
```

Video input takes `prompt`, plus optional `storage`, `model`, and `params` (as with
images), and two async controls: `pollIntervalMs` (poll cadence, default 5s) and
`timeoutMs` (give up and throw if it isn't ready in time, default 5 min). The
returned `video` is `{ url, contentType?, fileId?, storageError? }`.

## Dispatchable video: `video.launch`

`video.launch` is the dispatchable surface for video generation. It submits the
job and returns a handle immediately, so you decide when (or whether) to wait for
the result.

```typescript
import { createClient, VIDEO_RESULT_SIGNAL } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// Option A — block inline (same result as `video.create`, useful when you want
// a handle for tracking but still `await` in the same step):
const handle = await sapiom.contentGeneration.video.launch({
  prompt: "a calm ocean wave at sunset",
  storage: { visibility: "private" }, // optional — persist the output
});
const out = await handle.wait(); // polls until ready
out.video?.fileId;

// Option B — suspend a workflow step until the video is ready, then resume:
// (Inside a Sapiom workflow step; the orchestration engine handles the rest.)
const handle = await sapiom.contentGeneration.video.launch({
  prompt: "a calm ocean wave at sunset",
});
return pauseUntilSignal(handle, { resumeStep: finalize });
// `finalize` receives a VideoResultPayload: { outputs: [{ fileId?, storageError? }] }
```

`handle.wait()` accepts the same `timeoutMs` and `pollMs` overrides as
`video.create`'s input fields. `input.timeoutMs` / `input.pollIntervalMs` are the
defaults when `wait()` is called without arguments, so the two APIs stay in sync.

### `VIDEO_RESULT_SIGNAL`

The capability-stable signal constant — use it in the static `pause: { signal }`
declaration on a workflow step so the engine knows which signal to listen for:

```typescript
import { VIDEO_RESULT_SIGNAL } from "@sapiom/tools";

const finalize = defineStep({
  name: "finalize",
  pause: { signal: VIDEO_RESULT_SIGNAL },
  terminal: true,
  async run(result: VideoResultPayload, ctx) {
    result.outputs[0]?.fileId; // the persisted file, if storage was requested
  },
});
```

### `VideoResultPayload`

The shape delivered to a step resumed from `pauseUntilSignal`:

```typescript
interface VideoResultPayload {
  outputs: Array<{
    fileId?: string; // present when storage was requested and succeeded
    storageError?: string; // present when storage was requested but failed
  }>;
}
```

Import `VideoResultPayload` from `@sapiom/tools` to annotate the resumed step's
`input` type; import `toVideoResumePayload` to map a live `VideoGenerationResult`
to this shape when wiring local tests.

## Image input

- `prompt` (required) — the text prompt.
- `numImages` (optional) — how many images to generate.
- `storage` (optional) — persist outputs; `{ visibility: "private" | "public" }`.
- `model` (optional) — defaults to a fast image model; most callers omit it.
- `params` (optional) — advanced, model-specific parameters (e.g. `image_size`,
  `seed`, `guidance_scale`).

Each returned image is `{ url, contentType?, width?, height?, fileId?,
storageError? }`; any additional model-specific fields (e.g. `seed`) are returned
on the result as-is.

## Gotchas

- **Failed requests throw `ContentGenerationHttpError`** (carries `status` +
  parsed `body`), exported from `@sapiom/tools`.
- **`storage` is reserved** — a same-named field in `params` is ignored.
