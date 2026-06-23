# contentGeneration

Generate media — images today (video / audio to come) — with an optional `storage`
param that persists each output into Sapiom file-storage **server-side**, so you get
a durable `fileId` back inline. Provider-neutral: the surface names the capability,
not the upstream engine.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const out = await sapiom.contentGeneration.images.create({
  prompt: "a red bicycle",
  storage: { visibility: "private" }, // optional — persist outputs to file-storage
});

out.images[0].url; // hosted URL of the generated image
out.images[0].fileId; // present when `storage` was passed — use with `fileStorage`
```

Ambient import works too: `import { contentGeneration } from "@sapiom/tools"`.

## The optional `storage` stitch

Pass `storage` and the generated outputs are persisted into your tenant's
file-storage as they return — no extra round-trip, no client plumbing. Each item in
`images` is then annotated with its own `fileId`:

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

Persisting is **best-effort per image**: if one upload fails, that image carries a
`storageError` string instead of a `fileId` while the others still succeed.

## Input

- `prompt` (required) — the text prompt.
- `numImages` (optional) — how many images to generate.
- `storage` (optional) — persist outputs; `{ visibility: "private" | "public" }`.
- `model` (optional) — defaults to a fast image model; most callers omit it.
- `params` (optional) — advanced, model-specific parameters forwarded verbatim
  (provider-native names, e.g. `image_size`, `seed`, `guidance_scale`).

The SDK surface is camelCase (matching `fileStorage` / `agent`); wire fields are
mapped for you. Each returned image is `{ url, contentType?, width?, height?,
fileId?, storageError? }`; provider-native top-level extras (`seed`, `timings`, …)
pass through on the result as-is.

## Gotchas

- **Non-2xx responses throw `ContentGenerationHttpError`** (carries `status` +
  parsed `body`), exported from `@sapiom/tools`.
- **`storage` is reserved** for the stitch.
- **Base URL** defaults to the production generation gateway; override with the
  `SAPIOM_CONTENT_GENERATION_URL` env var (e.g. to target a staging gateway).
