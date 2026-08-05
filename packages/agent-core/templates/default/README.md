# __PROJECT_NAME__

A Sapiom agent, authored as code against [`@sapiom/agent`](https://www.npmjs.com/package/@sapiom/agent).

## Getting started

```sh
npm install
```

Then open `index.ts`. The agent is defined with `defineAgent({ steps })`; each step is a `defineStep({ name, next, run })`. The `run` body is ordinary code — and inside it, the full Sapiom tool catalog is available, pre-auth'd and tenant-scoped, on `ctx.sapiom`:

```ts
const box = await ctx.sapiom.sandboxes.create({ name: "demo" });
const repo = await ctx.sapiom.repositories.create("my-repo");
```

No credentials to wire — a per-execution tenant credential is injected for each agent run.

## The loop

Author and run this agent with the Sapiom dev tools:

- **check** — typecheck, bundle and import the definition, then validate its manifest and step graph. No Sapiom account or service call is required.
- **run_local** — execute the real steps locally with `ctx.sapiom.*` calls resolved from stubs, iterating until completion without Sapiom capability spend. Ordinary code in the project can still make its own network or machine changes.
- **deploy** — build and ship.

`npm run typecheck` and `npm run format` are also available for editor-level checks.

See `AGENTS.md` for the full authoring loop.
