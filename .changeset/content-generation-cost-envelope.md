---
"@sapiom/tools": minor
---

content-generation: surface the SAP-2576 per-generation cost envelope on image & video results

`ImageGenerationResult` / `VideoGenerationResult` — and the `images.launch` / `video.launch`
handles — now carry `cost?: MediaCostEnvelope` (`estimateUsd` inline plus the settled charge
out-of-band via `cost.reference`) and `resolvedModel?`, mirroring the backend capability
contract (SAP-2576). For video the envelope resolves at submit, so it is threaded from the
dispatch handle onto the polled result (the gateway's queue passthrough carries neither). A
reseller can now price a generation without a second API call.
