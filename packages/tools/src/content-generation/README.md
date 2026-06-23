# contentGeneration

Generate media — images today (video and audio to come) — with an optional
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

## Input

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
