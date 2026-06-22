# __PROJECT_NAME__

A Sapiom orchestration, authored as code against [`@sapiom/orchestration`](https://www.npmjs.com/package/@sapiom/orchestration).

## Getting started

```sh
npm install
```

Then open `index.ts`. The orchestration is defined with `defineOrchestration({ steps })`; each step is a `defineStep({ name, next, run })`. The `run` body is ordinary code — and inside it, the full Sapiom tool catalog is available, pre-auth'd and tenant-scoped, on `ctx.sapiom`:

```ts
const box = await ctx.sapiom.sandboxes.create({ name: 'demo' });
const repo = await ctx.sapiom.repositories.create('my-repo');
```

No credentials to wire — the engine injects a per-execution tenant credential when your orchestration runs.

## How it runs

Push this repo to Sapiom; the build bundles your definition, derives the step graph, and the engine executes it (pause/resume, retries, schedules, per-step cost — all built in). You author the steps; Sapiom runs them.
