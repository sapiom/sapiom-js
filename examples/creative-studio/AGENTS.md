# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Creative Studio** — authored against `@sapiom/agent`. It films one scene as a short multi-shot video in which the same character appears in every shot, with spoken lines rendered as native audio. Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here `ctx.sapiom.llm.run`, `ctx.sapiom.contentGeneration.images.create`, `ctx.sapiom.contentGeneration.video.{launch,create}`, `ctx.sapiom.agents.launch` and `ctx.sapiom.fileStorage`).

## The graph

One deployment plays two roles. A run whose input carries `shot` is a per-shot child; any other run is the coordinator.

```
coordinator:  plan ─▶ plate ─▶ shots ─▶ gather ⇄ gather ─▶ stitch ─▶ finalize
per-shot:     plan ─▶ keyframe ⇄ check ─▶ animate ─▶ clip
```

- **plan** — one structured `llm.run`: the character (face, hair, every item of clothing), a style bible, and exactly `numShots` shots. Each shot has an image-edit instruction, a motion prompt, an optional spoken line with its speaker, and a duration of 4–15s. `dryRun: true` stops here. In a per-shot child, `plan` skips straight to `keyframe`.
- **plate** — one `nano-banana-pro` image of the character alone, full body, on a plain background, at the requested aspect ratio. Every keyframe is an edit of this image. A vision call counts the figures: the model sometimes draws a multi-view character sheet, so a plate that is not exactly one figure with no text is redone once, then accepted with a warning.
- **shots** — `agents.launch` one child run of this same agent per shot (`definition: ctx.agentName`), all at once, then pause on the first.
- **gather** — records a finished child and pauses on the next by its execution id. When every child is in, it moves to `stitch`. A failed child becomes a warning and the rest are stitched.
- **keyframe** — `flux-pro-kontext-edit` with the plate as `referenceImage` and the shot's edit instruction.
- **check** — a vision `llm.run` compares the keyframe with the plate: same person, same clothing, palette, composition, and a 0–10 score. A failing keyframe (a different person, changed clothing, a composition that ignores the shot instruction, or under 7/10) goes back to `keyframe` once, with the issues fed into the prompt. A second failure is accepted with a warning. A check that cannot run is also a warning, never a block.
- **animate** — `seedance-i2v` with the keyframe `fileId` as `referenceImage`, the planned `duration`, and `audio: true` only when the shot has a line. The line is appended to the motion prompt in code, quoted verbatim. It never sends `aspectRatio`: `seedance-i2v` rejects it, and the clip follows the keyframe's shape.
- **clip** — keeps the clip in file storage (re-uploading it when the result has a URL but no `fileId`) and returns it to the coordinator.
- **stitch** — `fal-ai/ffmpeg-api/merge-videos` via `passthrough`. This is the one raw provider id in the template; the catalog has no merge alias. A single shot skips the merge.
- **finalize** — returns `{ downloadUrl, videoFileId, plateFileId, shots[], warnings[], costUsd, wallClockSeconds }`.

## Why the shots are child runs

`seedance-i2v` takes 3–9 minutes per clip, so shots must render at the same time. A paused step waits on one `(signal, correlationId)` pair, and the engine treats results differently by signal:

- An image or video job's completion webhook is dropped unless the run is paused on that exact job when it fires. Launching every video job and then pausing on them one by one would lose any clip that finished first.
- A child agent's result is parked until the parent pauses on it, in either order. `gather` can pause on child 2 after child 3 has already finished; the pause resumes at once with the parked result.

So each shot is its own run. Inside a child, `animate` pauses on exactly one video job, which is safe. The idempotency keys (`<executionId>:shot:<n>`, `:keyframe:<attempt>`, `:clip`, `:plate`, `:merge`) make a retried step reattach to the work it already started instead of paying for it twice.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run, ... })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by `@sapiom/tools` — read the types / use autocomplete rather than guessing. Which capability calls an LLM is the served rule ([Calling LLMs from steps](https://api.sapiom.ai/v1/agents/authoring-rules#llm-call-surface)); both model calls here are one-shot `llm.run` calls with `output`, read back with `structuredOf`, and no `model`.
- **Structured model calls go through `runStructured`.** `output` asks for a forced tool call, but a served model that thinks first does not always make it: on prod the plate check answered in prose in 7 of 10 calls. `runStructured` adds "Answer only by calling the tool" to the system prompt (0 of 10 missed with it) and retries a prose reply up to three times. Use it for any new structured call.
- **Pause edges are declared.** `shots` and `gather` declare `pause: { signal: AGENTS_RESULT_SIGNAL, resumeStep: "gather" }`; `animate` declares `pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: "clip" }`. `gather` pauses with the explicit form, `pauseUntilSignal({ signal, correlationId: childId, resumeStep })`, because the child's launch handle does not cross the step boundary.
- **The `shot` input is internal.** It is on the entry schema only so a child run can be started with it. Leave it empty when you run the agent.
- **Composing another agent.** `shots` launches `ctx.agentName`, the run's own slug, so a deployed copy needs no second deployment.

## Validating

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability and method you used exists.
- **`npm test`** — the plan reader, prompt builders and each step's branching, against fake capabilities.
- **check** — typecheck + bundle + manifest + step-graph validation.
- **run_local** with `{ "dryRun": true }` — runs the real `plan` step against a stubbed model, for free.
- **deploy**, then **run** — `run_local` cannot exercise the pauses, so test the full graph in the cloud: `{ "dryRun": true }` to check the plan, `{}` for one cheap real shot, then a multi-shot scene with dialogue.

> Write each step the way it should run in production. `run_local` adapts to your code (stub capabilities), not the other way around — never weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle, measured run times and cost.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw). The keyframe attempt counter, the child ids and the gather index live in `ctx.shared`; the idempotency keys above are derived from `ctx.executionId`, which is stable across retries.

## Platform rules (served, not restated here)

The rules that are true of Sapiom regardless of this project's SDK version — which capability
calls an LLM, database lifetime, trigger kinds, App Link webhooks, composing deployed agents —
are served live at <https://api.sapiom.ai/v1/agents/authoring-rules> and summarized in the
`sapiom-agent-authoring` skill's platform chapters. This file was written against release 1.1 of
that text; `sapiom_dev_agents_check` warns when the served copy differs.

<!-- sapiom-authoring-rules release=1.1 digest=8ed17f08af11 -->
