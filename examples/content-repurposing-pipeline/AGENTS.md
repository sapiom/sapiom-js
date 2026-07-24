# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Content Repurposing
Pipeline** — authored against `@sapiom/agent`. It fans one long-form source (a blog
post or transcript) out into a multi-channel content pack: tweet thread, LinkedIn
post, newsletter, quote graphics, and a short teaser clip. Inside a step's `run`,
Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here `ctx.sapiom.models.run`,
`ctx.sapiom.contentGeneration.images.create`, `ctx.sapiom.contentGeneration.video.launch`,
`ctx.sapiom.fileStorage`, and `ctx.sapiom.email`).

## The graph

```
repurpose ─▶ graphics ─▶ clip ─▶ collectClip ─▶ package ─▶ deliver
(models.run) (images.create) (video.launch) (drain)  (fileStorage) (email.send)
```

- **repurpose** — an LLM rewrites the source into every channel at once and returns
  minified JSON. A `dryRun` input terminates here with the copy only (no paid media).
- **graphics** — one quote graphic per pull-quote, **fanned out in-process**
  (`Promise.all`), each persisted (`storage`) for a durable `fileId`.
- **clip** — launches an async image-to-video job from the first graphic and
  `pauseUntilSignal`s on it. The `pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: 'collectClip' }`
  declaration is the graph edge; the video-generation webhook fires the signal to resume `collectClip`.
- **collectClip** — records the finished clip.
- **package** — renders the whole pack as one markdown doc and uploads it to file
  storage (`upload` → PUT the bytes → `getDownloadUrl`). The upload is best-effort:
  the full pack also ships inline in the email, so a storage hiccup degrades to "no
  durable link" rather than failing the run.
- **deliver** — emails the pack; returns a summary. Terminal.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run, ... })`.
  Keep exactly one `defineAgent(...)` export. (`package` is a reserved word, so the
  step const is `packageStep`, registered under the `package` key.)
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by
  `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong
  capability or method name fails typecheck. Note `ctx.sapiom.llm` does **not** exist;
  the LLM path is `ctx.sapiom.models.run({ prompt, system, maxTokens })`.
- **Async pause/resume.** A launched capability (`video.launch`) returns a dispatch
  handle; `return pauseUntilSignal(handle, { resumeStep })` suspends the step until the
  job's signal arrives. The step must also **declare** the edge:
  `pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep }`. The resumed step receives a
  `VideoResultPayload` (`{ outputs: [{ fileId?, downloadUrl? }] }`).
- **Defensive parsing.** The model returns minified JSON; `parsePack` slices to the
  outermost object and falls back to a usable pack built from the source, so a
  malformed reply never aborts the run.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run
tests in any project — reach for the local suite. You don't need to run it after every
small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method
  you used exists (plus the `VIDEO_RESULT_SIGNAL` import).
- **check** — typecheck + bundle + manifest + step-graph validation. The full local
  pre-flight before deploy.
- **run_local** with `{ "source": "...", "dryRun": true }` — runs your **real** step
  code against **stub capabilities** and traces the copy step offline for free, without
  any billed media.
- **deploy**, then **run** — ship it, then perform a real, billed run: copy → quote
  graphics → teaser clip → packaged + emailed.

> A full offline `run_local` (no `dryRun`) exercises `graphics` → `clip` → `package`.
> The default stubs return placeholder values, and `package` PUTs the pack to the
> stubbed upload URL with a raw `fetch` — which is why the upload is best-effort: on a
> stub it warns and continues to `deliver` rather than failing. `dryRun` is the clean
> free trace of the copy step.

> Write each step the way it should run in production. `run_local` adapts to your code
> (stub capabilities), not the other way around — never weaken or drop real logic to
> shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools
(`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Cost

A full run bills an LLM call, N quote **images**, one image-to-**video** clip, and one
email per run. Use `dryRun` while iterating on the copy, and start with a small
`numQuotes` for real runs.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw).
Capture non-deterministic values once and pass them forward via the `goto(...)` input
or `ctx.shared` rather than recomputing them. `graphics` fans out its images with a
single `Promise.all`, and `clip` pauses on exactly one launched job so its resume
signal always has a paused step to land on.
