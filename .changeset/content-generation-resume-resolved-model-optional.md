---
"@sapiom/tools": patch
---

content-generation: `resolvedModel` is now optional on the durable workflow-resume payload — the backend omits it for uncataloged models (SAP-2650).

`MediaResumeFields.resolvedModel` (shared by `VideoResultPayload` / `ImageResultPayload`) is now `resolvedModel?: string`. A real webhook-driven resume can legitimately arrive without it: for a non-cataloged model the gateway deliberately refuses to thread caller-controlled free text through this field on the resume payload (a stray `\n` would crash `fetch`, and the field would be spoofable), so it omits it best-effort — see SAP-2650.

`resolvedModel` stays **required** everywhere the routed backend always echoes the alias (verbatim even for an uncataloged raw id): `VideoGenerationResult` / `ImageGenerationResult` and the sync / poll / launch handles are unchanged. Only the resume payload contract relaxes; `toVideoResumePayload` / `toImageResumePayload` keep emitting it from the (still-required) result field.
