# __PROJECT_NAME__

A Sapiom orchestration that runs a **coding agent without blocking the workflow**:
it launches the agent fire-and-forget, suspends on the run's result signal, and
resumes once the run finishes — authored as code against
[`@sapiom/agent`](https://www.npmjs.com/package/@sapiom/agent).

```
prepare → kickoff ──pause(models.coding.result)──▶ finalize
```

- **kickoff** calls `models.coding.launch(...)` (which returns a handle, *not* a
  result) and returns `pauseUntilSignal(handle, { resumeStep: "finalize" })`. The
  workflow suspends — a long run holds no worker.
- **finalize** is resumed by the engine when the run reaches a terminal state.
  Its `input` **is** the run's result signal payload (typed `CodingResultPayload`).
  Because that payload crossed the pause/resume boundary, `sandbox` is plain data
  — re-attach a live handle with `ctx.sapiom.sandboxes.attach(name)` to push.

State that must survive the pause goes in `ctx.shared`. To test the **failure**
branch locally, stub a failed result under the *launching* step in
`.sapiom-dev/stubs.json` — that value is also the resume payload:

```jsonc
{ "version": 1, "steps": { "kickoff": { "models.coding.launch": { "status": "failed", "result": { "success": false }, "error": { "stage": "run", "message": "…" } } } } }
```

## Getting started

```sh
npm install
```

Then open `index.ts`. The orchestration is defined with `defineAgent({ steps })`; each step is a `defineStep({ name, next, run })`. The `run` body is ordinary code — and inside it, the full Sapiom tool catalog is available, pre-auth'd and tenant-scoped, on `ctx.sapiom`:

```ts
const box = await ctx.sapiom.sandboxes.create({ name: 'demo' });
const repo = await ctx.sapiom.repositories.create('my-repo');
```

No credentials to wire — a per-execution tenant credential is injected when your orchestration runs.

## The loop

Author and run this orchestration with the Sapiom dev tools:

- **check** — validate locally (bundle, manifest, step graph). Offline.
- **run_local** — execute the steps locally against stubs (no real capability calls), iterating until it completes.
- **deploy** — build and ship.

`npm run typecheck` and `npm run format` are also available for editor-level checks.

See `AGENTS.md` for the full authoring loop.
