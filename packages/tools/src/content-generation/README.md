# contentGeneration

Generate media — images today (video / audio to come) — with an optional `storage`
param that persists each output into Sapiom file-storage **server-side**, so you get
a durable `file_id` back inline. Provider-neutral: the surface names the capability,
not the upstream engine.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const out = await sapiom.contentGeneration.images.create({
  prompt: "a red bicycle",
  storage: { visibility: "private" }, // optional — persist outputs to file-storage
});

out.images[0].url; // hosted URL of the generated image
out.images[0].file_id; // present when `storage` was passed — use with `fileStorage`
```

Ambient import works too: `import { contentGeneration } from "@sapiom/tools"`.

## The optional `storage` stitch

Pass `storage` and the generated outputs are persisted into your tenant's
file-storage as they return — no extra round-trip, no client plumbing. Each item in
`images` is then annotated with its own `file_id`:

```typescript
const out = await sapiom.contentGeneration.images.create({
  prompt: "four color swatches",
  num_images: 4,
  storage: { visibility: "public" },
});
for (const img of out.images ?? []) {
  if (img.file_id) {
    const { downloadUrl } = await sapiom.fileStorage.getDownloadUrl(img.file_id);
  }
}
```

Persisting is **best-effort per image**: if one upload fails, that image carries a
`storage_error` string instead of a `file_id` while the others still succeed.

## Input

- `prompt` (required) — the text prompt.
- `storage` (optional) — persist outputs; `{ visibility: "private" | "public" }`.
- `model` (optional) — defaults to a fast image model; most callers omit it.
- Any other field is passed through to the model verbatim (e.g. `num_images`,
  `image_size`, `seed`).

The result is forwarded largely verbatim from the generation gateway (snake_case
fields like `content_type`, `seed`); the stitch only adds `file_id` /
`storage_error` inline.

## Gotchas

- **Non-2xx responses throw `ContentGenerationHttpError`** (carries `status` +
  parsed `body`), exported from `@sapiom/tools`.
- **`storage` is reserved** for the stitch — a same-named passthrough field is
  ignored.
- **Base URL** defaults to the production generation gateway; override with the
  `SAPIOM_CONTENT_GENERATION_URL` env var (e.g. to target a staging gateway).
