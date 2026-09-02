---
"@sapiom/tools": patch
---

Document `images.launch` in the content-generation README: the launch handle, `wait()` and its 2min/2s defaults, `IMAGE_RESULT_SIGNAL`, `ImageResultPayload`, and when to prefer `launch` over `create`. The async image path shipped in 0.25.0 with no README coverage. Also corrects the pause/resume snippets in both the image and video sections — `defineStep`'s `pause` requires `signal` and `resumeStep` and belongs on the pausing step, and the pause/resume helpers are imported from `@sapiom/agent`.
