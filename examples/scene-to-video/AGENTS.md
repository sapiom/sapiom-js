# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Scene → Images → Video** — authored against `@sapiom/agent`. It is the richest onboarding template: a real multi-step generative pipeline, not a one-shot text-to-image. Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here `ctx.sapiom.models.run`, `ctx.sapiom.contentGeneration.images.create`, and `ctx.sapiom.contentGeneration.video.launch`).

## The graph

```
decompose ─▶ keyframes ─▶ animate ⇄ collect ─▶ stitch ─▶ finalize
(models.run) (images.create) (video.launch) (drain)  (video.launch) (terminal)
```

- **decompose** — an LLM decomposes the scene into a global style/identity **bible** + an ordered shot list. A `dryRun` input terminates here with the plan only (no paid generation).
- **keyframes** — one keyframe image per shot, **fanned out in-process** (`Promise.all`), each persisted (`storage`) for a durable `fileId`.
- **animate** — launches an async image-to-video job for one shot and `pauseUntilSignal`s on it. The `pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: 'collect' }` declaration is the graph edge; the FAL webhook fires the signal to resume `collect`.
- **collect** — records the finished clip, then loops back to `animate` for the next shot or advances to `stitch`.
- **stitch** — a FAL ffmpeg-merge job concats the clips into one video, again async: pause → resume at `finalize`.
- **finalize** — terminal; returns the stitched video's `videoFileId` + `downloadUrl`.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run, ... })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong capability or method name fails typecheck. Note `ctx.sapiom.llm` does **not** exist; the LLM path is `ctx.sapiom.models.run({ prompt, system, maxTokens })`.
- **Async pause/resume.** A launched capability (`video.launch`) returns a dispatch handle; `return pauseUntilSignal(handle, { resumeStep })` suspends the step until the job's signal arrives. The step must also **declare** the edge: `pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep }`. The resumed step receives a `VideoResultPayload` (`{ outputs: [{ fileId?, downloadUrl? }] }`).
- **Why animate is sequential, not one paused step per clip at once.** A paused step waits on a single `(signal, correlationId)` pair. Launching every clip up front and then draining would risk a clip finishing before we've paused on it — its resume signal would have nowhere to land. Launching shot `i` only after shot `i-1` resumes keeps a paused step always waiting before its job can complete.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run tests in any project — reach for the local suite. You don't need to run it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method you used exists (plus the `VIDEO_RESULT_SIGNAL` import).
- **check** — typecheck + bundle + manifest + step-graph validation. The full local pre-flight before deploy.
- **run_local** with `{ "dryRun": true }` — runs your **real** step code against **stub capabilities** and traces the full graph offline for free, without any billed generation.
- **deploy**, then **run** — ship it, then perform a real, billed run: LLM plan → keyframe images → per-shot clips → stitched video.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Cost

This is the priciest template in the gallery: it bills an LLM call, N keyframe **images**, N image-to-**video** clips, and a merge job per run. Use `dryRun` while iterating on the graph, and start with a small `numShots` for real runs.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). Capture non-deterministic values once and pass them forward via the `goto(...)` input or `ctx.shared` rather than recomputing them. The `animate ⇄ collect` loop advances a single `animateIndex` counter in `ctx.shared`.
