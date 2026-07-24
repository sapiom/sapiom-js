# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Research →
Micro-Site Publisher** — authored against `@sapiom/agent`. It researches a topic,
synthesizes a cited report, then builds and deploys a live site from it:
`search` → `scrape` → `synthesize` → `build` → `publish` → `mapDomain` → `live`,
with `drafted` (dry-run) and `failed` off-ramps. Inside a step's `run`, Sapiom
capabilities are pre-auth'd on `ctx.sapiom` (here: `ctx.sapiom.search.webSearch`,
`ctx.sapiom.search.scrape`, `ctx.sapiom.models.run`,
`ctx.sapiom.models.coding.launch`, `ctx.sapiom.sandboxes.attach` +
`box.deployPreview`, `ctx.sapiom.domains.dns.create`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is
  defined by `@sapiom/tools` — read the types / use autocomplete rather than
  guessing. A wrong capability or method name fails typecheck.
- **The coding run is async.** `build` LAUNCHES the coding agent
  (`models.coding.launch`) and returns `pauseUntilSignal(handle, { resumeStep:
  "publish" })`; `publish` resumes with a `CodingResultPayload`. The run costs
  nothing while the agent works. Don't turn it into a blocking `run(...)` — the
  pause is what keeps a minutes-long build durable and free while idle.
- **The site must self-serve.** The coding task asks for `index.html` (inline CSS,
  no CDNs) and a zero-dependency `server.js`, so `deployPreview` needs no build
  step (`start: node server.js`). Keep that contract if you edit the task.
- **The custom domain is optional and assumed owned.** `mapDomain` creates a free
  CNAME on a domain you already own in `ctx.sapiom.domains`. With no `customDomain`
  set, the step is skipped and the preview URL is the deliverable.
- **`dryRun` gates every billed step after research.** It returns the report via
  `drafted` without building, deploying, or touching DNS.

## Validating

When you've made a coherent change and want to validate it — the same point
you'd run tests in any project — reach for the local suite. You don't need to run
it after every small edit.

- **`npm run typecheck`** — types, and confirms every `ctx.sapiom.*`
  capability/method you used exists.
- **check** — typecheck + bundle + manifest + step-graph validation. The full
  local pre-flight before deploy.
- **run_local** — runs your **real** step code against **stub capabilities**. Pass
  `{ "topic": "...", "dryRun": true }`: it traces `search → scrape → synthesize`
  and returns the computed report via `drafted` **without** building or deploying
  — so the graph traces offline, free. The coding build, the sandbox deploy, and
  their cost are only exercised on the deployed path.
- **deploy**, then **run** — ship it, then perform a real research → build →
  deploy and get back a live URL.

> Write each step the way it should run in production. `run_local` adapts to your
> code (stub capabilities + the `dryRun` guard), not the other way around — never
> weaken or drop real logic to shape a local run.

Drive `check` / `run_local` / `link` / `deploy` / `run` via the Sapiom MCP dev
tools (`sapiom_dev_agents_*`). See `README.md` for the full lifecycle.

## Determinism

A step body runs **once** on the happy path; it re-runs only on retry (after a
throw). Capture non-deterministic values (timestamps, ids) once and pass them
forward via the `goto(...)` input or `ctx.shared` rather than recomputing them.
