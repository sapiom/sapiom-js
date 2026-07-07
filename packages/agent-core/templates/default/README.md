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

Author and run this orchestration with the Sapiom dev tools:

- **check** — validate locally (bundle, manifest, step graph). Offline.
- **run_local** — execute the steps locally against stubs (no real capability calls), iterating until it completes.
- **deploy** — build and ship.

`npm run typecheck` and `npm run format` are also available for editor-level checks.

See `AGENTS.md` for the full authoring loop.
