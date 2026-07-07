# __PROJECT_NAME__

A Sapiom orchestration, authored as code against [`@sapiom/agent`](https://www.npmjs.com/package/@sapiom/agent).

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

```sh
npm run check     # validate locally: bundles, builds the manifest, checks the graph (offline)
npm run deploy    # build and ship
```

See `AGENTS.md` for how to work in this project with a coding agent.
