---
"@sapiom/tools": minor
---

Add `contentGeneration.video.launch()` — the dispatchable surface for video generation.

- `contentGeneration.video.launch(input)` submits a video generation job and returns a `VideoLaunchHandle` immediately. Pass the handle to `pauseUntilSignal(handle, { resumeStep })` to suspend a workflow step until the video is ready, or call `handle.wait()` to block inline.
- `VideoLaunchHandle` satisfies `DispatchHandle` — `dispatch.correlationId` and `dispatch.resultSignal` are the join keys the orchestration engine uses to resume a paused step.
- `VIDEO_RESULT_SIGNAL` (`"contentGeneration.video.result"`) is the capability-stable signal constant; use it in the static `pause: { signal }` declaration of a workflow step.
- `VideoResultPayload` and `toVideoResumePayload` describe the payload a resumed step receives across the wire boundary (plain JSON with `outputs[].fileId` / `outputs[].storageError`).
- Prompt-guard hardening: `images.create`, `video.create`, and `video.launch` now throw a typed error immediately when `prompt` is null, empty, or not a string — before any network request is made.
- `createStubClient()` wires `contentGeneration.video.launch` as a dispatchable stub that auto-registers a resume payload when `signals` is provided, enabling local workflow testing.
