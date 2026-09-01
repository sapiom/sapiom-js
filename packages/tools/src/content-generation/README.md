# contentGeneration

Generate media — images and video today (audio to come) — with an optional
`storage` param that persists each output to Sapiom file storage, so you get a
durable `fileId` — plus a ready-to-use `downloadUrl` — back inline.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const out = await sapiom.contentGeneration.images.create({
  prompt: "a red bicycle",
  storage: { visibility: "private" }, // optional — persist outputs to file storage
});

out.images[0].fileId; // durable reference (present when `storage` was passed)
out.images[0].downloadUrl; // ready-to-use, short-lived signed URL for the stored file
out.images[0].url; // provider-hosted URL (may be short-lived / unauthenticated)
```

Ambient import works too: `import { contentGeneration } from "@sapiom/tools"`.

## The optional `storage` param

Pass `storage` and each generated output is persisted to your tenant's file
storage as it returns — no extra round-trip. Each item in `images` is then
annotated inline with its own durable `fileId` and a ready-to-use `downloadUrl`:

```typescript
const out = await sapiom.contentGeneration.images.create({
  prompt: "four color swatches",
  count: 4,
  storage: { visibility: "public" },
});
for (const img of out.images ?? []) {
  if (img.downloadUrl) {
    // Ready to use immediately — but short-lived. `fileId` is the durable handle:
    // re-mint a fresh URL any time with `sapiom.fileStorage.getDownloadUrl(img.fileId)`.
    await fetch(img.downloadUrl);
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

out.video?.fileId; // durable reference (present when `storage` was passed)
out.video?.downloadUrl; // ready-to-use, short-lived signed URL for the stored file
out.video?.url; // provider-hosted URL (may be short-lived / unauthenticated)
```

Video input takes `prompt`, plus the optional neutral params (`aspectRatio`,
`resolution`, `duration`, `audio`, `seed`, `negativePrompt`, `referenceImage` —
see [Input params](#input-params)), `storage`, `model` / `select`
(see [Choosing a model](#choosing-a-model)), and two async controls:
`pollIntervalMs` (poll cadence, default 5s) and `timeoutMs` (give up and throw if
it isn't ready in time, default 5 min). The returned `video` is
`{ url, contentType?, fileId?, downloadUrl?, downloadUrlExpiresAt?, storageError? }`.

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
out.video?.fileId; // + out.video?.downloadUrl for a ready-to-use URL

// Option B — suspend an agent step until the video is ready, then resume:
// (Inside a Sapiom agent step; the orchestration engine handles the rest.)
const handle = await sapiom.contentGeneration.video.launch({
  prompt: "a calm ocean wave at sunset",
});
return pauseUntilSignal(handle, { resumeStep: finalize });
// `finalize` receives a VideoResultPayload: the outputs plus the generation's
// `resolvedModel` / `cost` metadata (see the interface below).
```

`handle.wait()` accepts the same `timeoutMs` and `pollMs` overrides as
`video.create`'s input fields. `input.timeoutMs` / `input.pollIntervalMs` are the
defaults when `wait()` is called without arguments, so the two APIs stay in sync.

### `VIDEO_RESULT_SIGNAL`

The capability-stable signal constant — use it in the static `pause: { signal }`
declaration on an agent step so the engine knows which signal to listen for:

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
  // Generation metadata, so a step that bills AFTER the generation can still
  // read what ran and what it cost (the launch handle is gone by resume time):
  resolvedModel?: string; // the alias that served it (omitted for uncataloged models)
  cost?: MediaCostEnvelope; // estimateUsd inline; settled charge via cost.reference
  outputs: Array<{
    fileId?: string; // durable ref — present when storage was requested and succeeded
    downloadUrl?: string; // ready-to-use short-lived URL (may have expired by resume)
    downloadUrlExpiresAt?: string; // ISO expiry of downloadUrl, when present
    downloadUrlUnavailable?: boolean; // fileId is set but no URL could be minted — re-fetch from fileId
    storageError?: string; // present when storage was requested but failed
  }>;
}
```

Import `VideoResultPayload` from `@sapiom/tools` to annotate the resumed step's
`input` type; import `toVideoResumePayload` to map a live `VideoGenerationResult`
to this shape when wiring local tests.

## Input params

Describe **what you want** with neutral params instead of provider-specific knobs.
They're validated against the chosen model _before_ you're charged and mapped to
that model's wire format, so switching models doesn't mean rewriting the call.
Passing an unsupported param throws `ContentGenerationHttpError` (`unsupported_param`)
**before any charge** — the response also carries `resolvedModel` and `cost`.

```typescript
const out = await sapiom.contentGeneration.video.create({
  prompt: "a calm ocean wave at sunset",
  aspectRatio: "9:16",
  audio: true,
  duration: 10,
});
out.resolvedModel; // the alias that served it
out.cost?.estimateUsd; // what it cost (inline quote)
out.cost?.reference; // Sapiom transaction id the charge lands on
```

`cost` is the per-generation `MediaCostEnvelope`: `estimateUsd` (with `currency`,
`isEstimate`, `source`) is the inline quote — for `upto`-priced video models it's
the authorized **ceiling**, so the settled amount can be lower — and
`cost.reference` is the transaction id where the authoritative **settled** amount
lives out-of-band, at `GET /v1/transactions/:id/costs`. Either half is omitted
(never zeroed or fabricated) when it didn't resolve; re-billing callers should
persist `cost.reference` and settle from it.

**Images** (`images.create` / `images.launch`): `prompt` (required), plus optional
`aspectRatio`, `count`, `seed`, `negativePrompt`, `referenceImage`, `outputFormat`.

**Video** (`video.create` / `video.launch`): `prompt` (required), plus optional
`aspectRatio`, `resolution`, `duration` (whole seconds), `audio`, `seed`,
`negativePrompt`, `referenceImage`.

Shared:

- `model` (optional) — a **public semantic alias** (e.g. `"flux-fast"`,
  `"veo3-fast"`); defaults to a fast model. Most callers omit it. See
  [Choosing a model](#choosing-a-model) — raw provider ids are deprecated.
- `select` (optional) — capability-based model selection, used when `model` is
  omitted. See [Choosing a model](#choosing-a-model).
- `storage` (optional) — persist outputs; `{ visibility: "private" | "public" }`.
- `idempotencyKey` (optional) — cross-call idempotency key; a repeat with the same
  key (per tenant) returns the existing generation instead of a new one, like
  `agents.run`. Arbitrary string ≤255 (not a UUID).
- `passthrough` (optional) — escape hatch for a raw provider knob the neutral
  vocabulary doesn't cover; merged last, so it overrides the neutral fields.
- `numImages` / `params` — **deprecated**, still honored; superseded by `count` /
  `passthrough`. (`params` and `passthrough` are not drop-in aliases: the merge
  order is `params` < neutral fields < `passthrough`.)

Each returned image is `{ url, contentType?, width?, height?, fileId?,
downloadUrl?, downloadUrlExpiresAt?, storageError? }`; any additional
model-specific fields are returned on the result as-is.

## Choosing a model

`model` takes a **public semantic alias** — Sapiom's own neutral name for a model,
resolved to a concrete provider model server-side. Aliases are the supported input.

Raw provider model ids are **deprecated**. An existing pin still works, and this
release changes nothing about that, but raw ids are not part of the public surface and
support for them will be removed in a future release — migrate pins to an alias.

```typescript
import { IMAGE_MODELS, VIDEO_MODEL_ALIASES } from "@sapiom/tools";

await sapiom.contentGeneration.images.create({
  prompt: "a red bicycle",
  model: IMAGE_MODELS.fluxStandard, // or just "flux-standard"
});
```

| Images (`IMAGE_MODELS`) | Video (`VIDEO_MODEL_ALIASES`) |
| ----------------------- | ----------------------------- |
| `flux-fast` (default)   | `veo3-fast` (default)         |
| `flux-standard`         | `seedance-fast`               |
| `ideogram-v3`           | `seedance-standard`           |
| `flux-pro-kontext`      | `kling-standard`              |
| `nano-banana-pro`       | `wan-standard`                |
| `gpt-image-2`           | `minimax-h3-max`              |

Both are listed in the platform's catalog order, which is the order it considers
them in when you omit `model`. Treat it as a stable listing, not a price ranking — if
you want the cheapest, ask for it with `select.prefer` below.

Neither is a closed set: `model` is typed as a literal union widened to `string`, so a
newly-cataloged alias works before this SDK catches up, and the SDK never validates the
value locally — the platform catalog is the authority.

> The `VIDEO_MODELS` export (raw provider model ids) is **deprecated**. Video routes
> through the same alias-resolving capability as images, so the same guidance applies:
> the pins still work, but migrate them — `veo3Fast` → `"veo3-fast"`,
> `klingV16StandardText` → `"kling-standard"`, `wanV22Text` → `"wan-standard"`,
> `seedance20Fast` → `"seedance-fast"`. `minimaxVideo01` has no cataloged alias —
> switch it to a cataloged model such as `"minimax-h3-max"`.

### Let the platform pick: `select`

Omit `model` and the platform chooses one for you. Your neutral params already narrow
the candidates on their own; `select` covers what they can't express, and the response
echoes the choice as `resolvedModel`:

```typescript
const out = await sapiom.contentGeneration.video.create({
  prompt: "a person speaking to camera",
  aspectRatio: "9:16",
  duration: 6,
  select: {
    requires: ["audio", "lipsync"], // intrinsic capabilities the model must declare
    prefer: "cheapest", // re-rank the survivors by a live price join
  },
});
out.resolvedModel; // e.g. "seedance-fast" — what the platform picked
out.preferSatisfied; // true: cheapest verified against every candidate
```

- `requires` — capability tags the chosen model must declare: `"audio"`, `"lipsync"`,
  `"referenceImage"`. **Video only** — see [`select` and images](#select-and-images)
  below. An unknown tag is rejected as an unsupported param. `requires` is intended to
  hold whether or not you also pin `model` — it states a requirement, not a tie-breaker.
- `prefer: "cheapest"` — re-ranks the surviving candidates by a **live** price join. It
  degrades, never fails: if the join is unavailable, slow, or incomplete, selection falls
  back to deterministic catalog order and the response reports `preferSatisfied: false`.
  A `true` means the cheapest was verified against _every_ candidate.
- `preferSatisfied` is **absent** unless you asked for a preference — never a
  fabricated `false`.

`"cheapest"` compares the live price of your exact request as each candidate would run
it, not a fixed per-model tier. Omit `duration` (video) / `count` (images) and each
candidate is priced at its _own_ catalog default, so a model with a shorter default can
win on absolute price — pin them to compare on equal terms.

If no model satisfies the constraints, the request fails before any charge.

### `select` and images

`select` is typed per media type, because the two do not offer the same capabilities.
**`requires` is video-only.** No image model in the catalog declares a capability tag, so
`ImageSelect` is `{ prefer?: "cheapest" }` and asking an image call for `requires` is a
compile error rather than a request that can only fail:

```typescript
// Images: prefer is the whole surface.
await sapiom.contentGeneration.images.create({
  prompt: "a red bicycle",
  select: { prefer: "cheapest" },
});
```

If image conditioning is cataloged later, `requires` gets added to `ImageSelect` — a
non-breaking change, which is why it is left off now rather than shipped unsatisfiable.

Writing code generic over both media types? `MediaSelect` is the shape the two share
(`{ prefer?: "cheapest" }`), and a value of that type is accepted by either call. It is
the shared shape rather than a union of the two, so it really is assignable to both —
name the specific `VideoSelect` when you need `requires`.

## Gotchas

- **Failed requests throw `ContentGenerationHttpError`** (carries `status` +
  parsed `body`), exported from `@sapiom/tools`.
- **`storage` is reserved** — a same-named field in `params` is ignored.
