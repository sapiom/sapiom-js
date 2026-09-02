---
"@sapiom/tools": minor
---

`contentGeneration`: an async image or video job that terminally FAILS is now distinguishable from one that is merely slow (SAP-3097).

**`wait()` fails fast.** Every non-OK poll response used to be treated as "still generating", so a job that failed in three seconds burned the caller's whole `timeoutMs` and then threw `Image generation did not complete within 300000ms` — the opposite of what happened. `wait()` (and `video.create`, which polls the same way) now reads the queue's terminal state and throws the new `ContentGenerationFailedError` as soon as the job fails, carrying `requestId` and the provider's own `providerError`. A plain `Error` about the timeout now means only what it says: the job was still running when you stopped waiting.

A transport blip still keeps polling. A non-OK result poll is ambiguous on its own, so it is disambiguated against the status endpoint — the canonical terminal channel — and anything short of an explicit terminal marker keeps the poll going.

**`generationError` on the resume payload.** `ImageResultPayload` and `VideoResultPayload` outputs gain `generationError?: string`. A terminal provider failure used to arrive on `storageError` — the field documented as "persisting this output failed" — so a resumed workflow step concluded storage broke when in fact nothing was ever generated. The two are now separate fields and never both apply to one output: branch on `generationError` for "the model failed", `storageError` for "the model succeeded but we couldn't keep the result".

This also makes `VIDEO_RESULT_SIGNAL`'s documented "carries the result either way (ready OR failed)" contract true; the payload previously had nowhere to put the failure. `IMAGE_RESULT_SIGNAL` carries the same contract.

`ContentGenerationFailedError` is exported from `@sapiom/tools`.
