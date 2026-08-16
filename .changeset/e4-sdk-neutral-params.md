---
"@sapiom/tools": minor
---

content-generation: surface the E4 neutral param vocabulary on the SDK (SAP-2579)

`contentGeneration.images.create` / `.launch` and `contentGeneration.video.create` / `.launch` now
accept the neutral params as first-class typed fields — images: `aspectRatio`, `count`, `seed`,
`negativePrompt`, `referenceImage`, `outputFormat`; video: `aspectRatio`, `resolution`, `duration`,
`audio`, `seed`, `negativePrompt`, `referenceImage` — plus a `passthrough` escape hatch. The router
validates each against the chosen model **before payment** and maps it to that model's provider
format, so a caller can write `video.create({ prompt, aspectRatio: "9:16", audio: true, duration: 10 })`
without any provider-specific param names. `numImages` and `params` keep working as `@deprecated`
aliases of `count` and `passthrough`. New exported types: `AspectRatio`, `Resolution`, `OutputFormat`.
