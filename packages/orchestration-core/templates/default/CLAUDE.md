# Working in this orchestration

Follow [AGENTS.md](./AGENTS.md) for authoring and validation.

This project ships a near-complete local suite — `npm run typecheck`, the **check** tool (typecheck + bundle + manifest + graph), and **run_local** (runs your real step code against stub capabilities, including handle methods like `repo.pushFromSandbox`). Reach for it when you'd normally validate a change (not after every small edit), and rely on `check` / `typecheck` to confirm the `ctx.sapiom.*` capabilities you used exist.

`run_local` works with no stubs (capabilities return defaults); add overrides in `.sapiom-dev/stubs.json` only for results a step branches on. Write each step the way it should run in production — never weaken or drop real logic to shape a local run.
