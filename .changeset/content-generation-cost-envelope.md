---
"@sapiom/tools": minor
---

content-generation: surface the SAP-2576 per-generation cost envelope + `resolvedModel` across every media-result path

Consumers (e.g. Polsia ads re-billing its customers' wallets) can now price a generation without a second API call, consistently across synchronous image calls, polled results, launch handles, AND durable workflow resumes:

- New `MediaCostEnvelope` (`estimateUsd` inline + the settled charge out-of-band via `cost.reference`) and `resolvedModel` on `ImageGenerationResult` / `VideoGenerationResult` and the `images.launch` / `video.launch` handles.
- `resolvedModel` is **required** (the routed backend always echoes it — a cataloged raw id reverse-maps to its alias, an uncataloged one is echoed verbatim), matching the backend SAP-2576 contract. `cost` stays optional (quote/reference are best-effort).
- The durable resume payload (`VideoResultPayload` / `ImageResultPayload`, via `toVideoResumePayload` / `toImageResumePayload`) now carries `resolvedModel` + `cost` (new shared `MediaResumeFields`), so a workflow step that bills in the **resumed** step — after generation — can still read `cost.reference`.
- For video the envelope resolves at submit and is threaded from the dispatch handle onto the polled result (the gateway's queue passthrough carries neither).

> Companion (backend, chengdu): the Fal workflow-resume producer must emit `resolvedModel` + `cost` in the resume payload JSON for real webhook-driven resumes to carry them; the SDK mapper covers local stubs/tests only.
