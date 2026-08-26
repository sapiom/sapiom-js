# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Content Pack** —
authored against `@sapiom/agent`. It fans one long-form source (a blog post or
transcript) out into a multi-channel content pack: tweet thread, LinkedIn post,
newsletter, quote graphics, and a short teaser clip — then fans the finished
pack back out to every recipient on the list. Inside a step's `run`, Sapiom
capabilities are pre-auth'd on `ctx.sapiom` (here `ctx.sapiom.llm.run`,
`ctx.sapiom.contentGeneration.images.launch`,
`ctx.sapiom.contentGeneration.video.launch`, `ctx.sapiom.fileStorage`, and
`ctx.sapiom.email`).

## The graph

```
repurpose ─▶ graphics ⇄ collectGraphic ─▶ clip ⇄ collectClip ─▶ package ─▶ deliver
(llm.run) (images.launch) (drain)      (video.launch) (drain) (fileStorage) (email.send × N)
```

- **repurpose** — an LLM rewrites the source into every channel at once and returns
  minified JSON. A `dryRun` input terminates here with the copy only (no paid media).
- **graphics ⇄ collectGraphic** — one quote graphic at a time, launched async
  (`images.launch`) and paused on (`pause: { signal: IMAGE_RESULT_SIGNAL, resumeStep:
'collectGraphic' }`); `collectGraphic` records it and loops back for the next quote or
  advances once every graphic is in. Sequential, not a concurrent `Promise.all` — see
  "Why sequential" below.
- **clip ⇄ collectClip** — launches an async text-to-video job (a cataloged
  semantic alias, with a purpose-written short visual prompt — never the LLM's
  narration-shaped output; see `buildClipPrompt`) and `pauseUntilSignal`s on it. The
  `pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: 'collectClip' }` declaration is
  the graph edge; the video-generation webhook fires the signal to resume `collectClip`.
- **package** — renders the whole pack as one markdown doc and uploads it to file
  storage (`upload` → PUT the bytes → `getDownloadUrl`). The upload is best-effort:
  the full pack also ships inline in the email, so a storage hiccup degrades to "no
  durable link" rather than failing the run.
- **deliver** — the fan-out: maps over every `deliverTo` recipient, sends each their
  own copy of the pack, and reduces the results into one `delivered` count. Terminal.

## Fan-out, absorbed from `personalized-media-at-scale`

`deliver`'s recipient loop is the map-reduce pattern `personalized-media-at-scale`
used for its per-row asset delivery: map over the list, dispatch each item
independently inside a `try`/`catch` so one bad address can't sink the batch, then
reduce into a single summary (`delivered`, `recipients[]`). `isReservedAddress`
is ported over unchanged — an RFC 2606 placeholder domain (`example.com`, etc.)
is skipped rather than counted as delivered, the same honesty rule that template
applied to its seeded demo rows.

## Why sequential, not concurrent, for `graphics` and `clip`

A paused step waits on a single `(signal, correlationId)` pair. Launching every
image job up front and then draining would risk one finishing before we've
paused on it (its resume signal would have nowhere to land) — the same reasoning
`scene-to-video` documents for its keyframe/animate loops. This is also why
`graphics` moved OFF the old synchronous `images.create` + `Promise.all` fan-out:
a concurrent fan-out of the routed sync call risked tripping Core's 30s router
cap; `images.launch` (like `video.launch`) enqueues and returns immediately, so
that wall no longer applies.

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run, ... })`.
  Keep exactly one `defineAgent(...)` export. (`package` is a reserved word, so the
  step const is `packageStep`, registered under the `package` key.)
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined by
  `@sapiom/tools` — read the types / use autocomplete rather than guessing. A wrong
  capability or method name fails typecheck. One-shot LLM work uses
  `ctx.sapiom.llm.run({ request: { system, messages, max_tokens } })` through the
  gateway.
- **Async pause/resume.** A launched capability (`images.launch`, `video.launch`)
  returns a dispatch handle; `return pauseUntilSignal(handle, { resumeStep })`
  suspends the step until the job's signal arrives. The step must also **declare**
  the edge: `pause: { signal: IMAGE_RESULT_SIGNAL, resumeStep }` (or
  `VIDEO_RESULT_SIGNAL`). The resumed step receives an `ImageResultPayload` /
  `VideoResultPayload` (`{ outputs: [{ fileId?, downloadUrl? }] }`).
- **Defensive parsing.** The model returns minified JSON; `parsePack` slices to the
  outermost object and falls back to a usable pack built from the source, so a
  malformed reply never aborts the run.

## Validating

When you've made a coherent change and want to validate it — the same point you'd run
tests in any project — reach for the local suite. You don't need to run it after every
small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*` capability/method
  you used exists (plus the `IMAGE_RESULT_SIGNAL` / `VIDEO_RESULT_SIGNAL` imports).
- **`npm test`** — the pure helpers (`isReservedAddress`) and the `deliver` step's
  fan-out/reduce behavior against a mock context.
- **check** — typecheck + bundle + manifest + step-graph validation. The full local
  pre-flight before deploy.
- **run_local** with `{ "source": "...", "dryRun": true }` — runs your **real** step
  code against **stub capabilities** and traces the copy step offline for free, without
  any billed media.
- **deploy**, then **run** — ship it, then perform a real, billed run: copy → quote
  graphics → teaser clip → packaged + emailed to every recipient.

> A full offline `run_local` (no `dryRun`) exercises `graphics` → `collectGraphic` →
> `clip` → `collectClip` → `package`. The default stubs return placeholder values, and
> `package` PUTs the pack to the stubbed upload URL with a raw `fetch` — which is why
> the upload is best-effort: on a stub it warns and continues to `deliver` rather than
> failing. `dryRun` is the clean free trace of the copy step.

> Write each step the way it should run in production. `run_local` adapts to your code
> (stub capabilities), not the other way around — never weaken or drop real logic to
> shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev tools
(`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Cost

A full run bills an LLM call, N quote **images**, one image-to-**video** clip, and one
email per recipient. Use `dryRun` while iterating on the copy, `renderClip: false` for the cheaper
middle ground (real graphics, no clip — the clip is the priciest leg), and start with a small
`numQuotes` for real runs.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a throw).
Capture non-deterministic values once and pass them forward via the `goto(...)` input
or `ctx.shared` rather than recomputing them. `graphics` launches and pauses on exactly
one image job per turn, and `clip` pauses on exactly one launched job, so a resume
signal always has a paused step to land on.
