# @sapiom/orchestration

The versioned public contract for authoring Sapiom orchestrations.

A lean, dependency-light package (types + a small protocol runtime, with a single
strictly-pinned `zod` peer) shared by three consumers:

- **Customer orchestration definitions** — authored against this package's types and
  compiled by the build.
- **The sandbox step-runner** — reads a step's input, builds `ctx`, runs one step.
- **The engine** — uses the directive guards + manifest schema; it never runs
  customer code, only validates the pure-data completion payload.

## Install

```sh
npm install @sapiom/orchestration zod
```

`zod` is a peer dependency, pinned to the `3.25.x` line (the SDK uses the `zod/v4`
subpath).

## Authoring surface

```ts
import { defineOrchestration, defineStep, goto, terminate } from '@sapiom/orchestration';

const start = defineStep({
  name: 'start',
  next: ['finish'],
  async run(input, ctx) {
    return goto('finish', { greeting: `hello ${input.name}` });
  },
});

const finish = defineStep({
  name: 'finish',
  next: [],
  terminal: true,
  async run() {
    return terminate({ done: true });
  },
});

export const hello = defineOrchestration({
  name: 'hello',
  entry: 'start',
  steps: { start, finish },
});
```

A step declares the transitions it may take (`next` / `terminal` / `canFail` /
`pause`); the `run` return type is derived from those declarations, so an
undeclared transition is a compile error. The build reads those same declarations
to render the orchestration graph without executing anything.
