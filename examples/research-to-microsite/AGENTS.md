# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Research →
Micro-Site Publisher** — authored against `@sapiom/agent`. It researches a
topic, self-critiques and revises the write-up (the eval-gate idiom, folded
in — see `examples/eval-gate`), illustrates it, then builds and deploys a
live site from it:

```
plan → gather → synthesize ⇄ critique → illustrate ⇄ collectIllustration → build → publish → mapDomain → live
```

with `drafted` (dry-run, or nothing to research), `failed`, and
`builtNotPublished` off-ramps. `critique.ts` factors out the judge prompt +
score parser, the same shape `eval-gate/judge.ts` uses. Inside a step's
`run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here:
`ctx.sapiom.search.webSearch`, `ctx.sapiom.search.scrape`,
`ctx.sapiom.models.run`, `ctx.sapiom.contentGeneration.images.launch`,
`ctx.sapiom.fileStorage.getDownloadUrl`, `ctx.sapiom.models.coding.launch`,
`ctx.sapiom.sandboxes.attach` + `box.deployPreview`,
`ctx.sapiom.domains.dns.create`).

This template absorbed and replaces `web-research-digest` — its
search → cited-digest shape is a strict subset of `gather` → `synthesize`
here (multiple queries, deduped, full-text scraped, rather than one search's
synthesized answer).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.
- **Two async pauses, same shape.** `illustrate` launches an image job per
  section and pauses on `IMAGE_RESULT_SIGNAL`, resuming `collectIllustration`
  one section at a time — the same fan-out shape `scene-to-video`'s
  `keyframe` ⇄ `collectKeyframe` uses, for the same reason (a paused step
  waits on one `(signal, correlationId)` pair, so the next launch only fires
  after the previous one resumed). `build` then launches the coding agent
  (`models.coding.launch`) and returns
  `pauseUntilSignal(handle, { resumeStep: "publish" })`. Neither should
  become a blocking `run(...)` — the pauses are what keep a minutes-long job
  durable and free while idle.
- **The self-critique loop is bounded.** `critique` never loops past
  `maxDraftAttempts` (default 2: one initial `synthesize` + one revision) —
  `decide`-style branch logic lives inside `critique` itself, not a separate
  step, to keep the named graph close to the ~7-phase target.
- **Illustration is best-effort and boundable to zero.**
  `illustrationCount: 0` skips `illustrate` entirely; a failed launch or a
  job with no usable output just means one fewer picture, routed through the
  same `collectIllustration` degrade path either way — never a failed run.
- **The site must self-serve.** The coding task asks for `index.html` (inline CSS,
  no CDNs) and a zero-dependency `server.js`, so `deployPreview` needs no build
  step (`start: node server.js`). Keep that contract if you edit the task.
- **The custom domain is optional and assumed owned.** `mapDomain` creates a free
  CNAME on a domain you already own in `ctx.sapiom.domains`. With no `customDomain`
  set, the step is skipped and the preview URL is the deliverable.
- **`dryRun` gates every billed step after self-critique settles.** It
  returns the report via `drafted` without illustrating, building,
  deploying, or touching DNS.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to run
it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **`npm test`** (`tsx --test index.test.mjs`) — unit tests against individual
  step `run` functions with a minimal ctx double: the critique loop's
  revise/pass/exhausted/dryRun branches, the illustration fan-out's degrade
  paths, gather's cross-query dedupe, and publish's honest-degrade cases.
- **check** — typecheck + bundle + manifest + step-graph validation. The full
  local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**. Pass
  `{ "topic": "...", "dryRun": true }`: it traces
  `plan → gather → synthesize → critique` and returns the computed report via
  `drafted` **without** illustrating, building, or deploying — so the graph
  traces offline, free. Illustration, the coding build, the sandbox deploy,
  and their cost are only exercised on the deployed path.
- **deploy**, then **run** — ship it, then perform a real
  research → critique → illustrate → build → deploy and get back a live URL.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities + the `dryRun` guard), not the other way around — never
> weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
