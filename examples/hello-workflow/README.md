# Hello Workflow

The minimal single-step Sapiom orchestration — a smoke test for the
`build → deploy → run` path. One terminal step, no capabilities.

Use it to confirm your MCP install and deploy pipeline work end to end before
reaching for a metered capability.

## What it does

`greet` validates an optional `name` input and returns `{ greeting: "Hello, <name>!" }`.
When no name is given it greets `world`.

```
greet  (terminal)
```

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_orchestrations_check` → `sapiom_dev_orchestrations_run_local` →
   `sapiom_dev_orchestrations_link` → `sapiom_dev_orchestrations_deploy` →
   `sapiom_dev_orchestrations_run`.

## Files

- `index.ts` — the orchestration (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
