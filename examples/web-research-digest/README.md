# Web Research Digest

Search the web for a topic and return a concise, sourced digest. The onboarding
flagship: one metered capability (`web.search`) and an obvious output.

## What it does

```
search  ──▶  summarize  (terminal)
(web.search)   (in-process)
```

1. **search** — takes a `topic`, calls the Sapiom search capability
   (`ctx.sapiom.search.webSearch`), and forwards the synthesized answer + results.
2. **summarize** — formats the answer and its source links into a markdown digest
   in-process (no LLM), returning `{ topic, digest, sources }`.

Input: `{ "topic": "what is an LLM agent?" }`.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the `search` step
   inherits that authority to call the metered capability.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (capabilities stubbed, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`
   (a real, billed web search).

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
