---
"@sapiom/tools": minor
---

`contentGeneration.images` / `contentGeneration.video`: `ImageCreateInput` and `VideoCreateInput` gain an optional `idempotencyKey` — a caller-supplied cross-call idempotency key (arbitrary string ≤255, not a UUID) forwarded verbatim as a top-level request field. A repeat with the same key (per tenant) returns the existing generation instead of launching a new one, matching `agents.run` semantics. The SDK only forwards it — across the sync `create` and async `launch` paths, image and video; the platform validates and deduplicates (SAP-2578 / E7 phase 3).
