---
"@sapiom/tools": minor
---

`contentGeneration.images.launch` — a dispatchable async surface for image generation, mirroring
`video.launch`.

The routed synchronous `images.create` holds its HTTP request open for the full generate+store,
which meets Core's 30s router cap: a concurrent fan-out (`Promise.all` over N rows) drove every
request in the batch past 30s, so the whole step 503'd on every retry. The backend already supported
async image dispatch (`dispatch: 'async'`, SAP-1802) over the same fal-queue → webhook → resume rail
as video, but the SDK never exposed it.

`images.launch` submits with `dispatch: 'async'`, forwards the workflow resume token, and returns an
`ImageLaunchHandle` (`requestId`, `dispatch`, and an inline `wait()`) — so the submit returns as soon
as the job is enqueued and the 30s wall no longer applies. Pass the handle to
`pauseUntilSignal(handle, { resumeStep })` to suspend a workflow step until the image is ready, or
`await handle.wait()` to poll inline. Also exported: `IMAGE_RESULT_SIGNAL`, the `ImageResultPayload`
shape a resumed step receives, and `toImageResumePayload`. `images.create` is unchanged. No backend
change is required — the async completion→resume path is media-agnostic.
