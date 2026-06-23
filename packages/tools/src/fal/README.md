# fal

Image generation through the Sapiom Fal gateway — the same Fal capability your
agents call over MCP, callable directly from your code. Its one Sapiom-specific
addition is an optional `storage` param that persists each output into Sapiom
file-storage **server-side**, so you get a durable `file_id` back inline.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const out = await sapiom.fal.run({
  model: "fal-ai/flux/schnell",
  input: { prompt: "a red bicycle", num_images: 1 },
  storage: { visibility: "private" }, // optional — persist outputs to file-storage
});

out.images[0].url; // Fal's hosted media URL
out.images[0].file_id; // present when `storage` was passed — use with `fileStorage`
```

Ambient import works too: `import { fal } from "@sapiom/tools"`.

## The optional `storage` stitch

Pass `storage` and the gateway persists every generated output into your tenant's
file-storage as it returns — no extra round-trip, no client plumbing. Each item in
`images` is then annotated with its own `file_id`:

```typescript
const out = await sapiom.fal.run({
  model: "fal-ai/flux/schnell",
  input: { prompt: "four color swatches", num_images: 4 },
  storage: { visibility: "public" },
});
for (const img of out.images ?? []) {
  if (img.file_id) {
    const { downloadUrl } = await sapiom.fileStorage.getDownloadUrl(
      img.file_id,
    );
  }
}
```

Persisting is **best-effort per image**: if one upload fails, that image carries a
`storage_error` string instead of a `file_id` while the others still succeed.

## Passthrough shape

Unlike `fileStorage` (a Sapiom-native API surfaced in camelCase), `fal` is a
passthrough: both the model `input` and the returned object are **Fal-native**
(snake_case — `num_images`, `content_type`, `has_nsfw_concepts`, …), matching
Fal's own docs. The stitch only adds `file_id` / `storage_error` inline; everything
else is forwarded verbatim.

## Gotchas

- **`storage` is sync-image only (today).** Passing `storage` to an async (queued)
  video/audio model is a `400`. Without `storage`, those models behave exactly as
  Fal's standalone capability (you get a queue handle).
- **Non-2xx responses throw `FalHttpError`** (carries `status` + parsed `body`),
  exported from `@sapiom/tools`.
- **`model` carries slashes** (`fal-ai/flux/schnell`) — they're preserved as path
  segments; leading/trailing/duplicate slashes are dropped.
- **Base URL** defaults to the production gateway; override with the `SAPIOM_FAL_URL`
  env var (e.g. to target a staging gateway).
