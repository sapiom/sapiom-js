# Managed Loop with MCP

Answer a question with the managed loop (`ctx.sapiom.models.run` / `models.launch`),
using a remote MCP server as the model's tools.

```
prepare ─┬─▶ ask ──(pause: models.run.result)──▶ report
         └─▶ rejected
```

- `prepare` reads `question` and `mcpUrl` (both default) and rejects an `mcpUrl`
  that is not an absolute https URL.
- `ask` calls `ctx.sapiom.models.launch({ prompt, system, mcps: [{ url, headers? }] })`
  and pauses on the handle. The loop runs in Sapiom's server: it calls the model,
  calls the MCP server's tools when the model asks, and repeats until it answers.
  `model` is omitted, so the platform routes the run.
- `report` receives the run result (`ModelRunResultPayload`). It fails the run if
  `status` is not `completed` or `output` is empty; otherwise it returns the answer
  with `turns` and `result.servedClass`.

The default MCP server is DeepWiki's public server (`https://mcp.deepwiki.com/mcp`,
no auth), which answers questions about public GitHub repositories, so `{}` in
produces a real answer. To use your own Streamable HTTP MCP server, pass its URL as
`mcpUrl`. The template sends the server no credentials. For a server that needs
auth, fix its URL in `index.ts` and add the header in `mcpFor`; never attach a
credential to a URL taken from run input, or whoever starts a run can send it
anywhere.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. From this directory, run `npm install`, then `sapiom_dev_agents_check` and
   `sapiom_dev_agents_run_local`. Under `run_local`, `models.launch` is stubbed and
   `ask`'s pause resumes `report` with the stub result. Stub it in the `ask` step to
   control what `report` receives:

   ```json
   {
     "version": 1,
     "steps": {
       "ask": {
         "models.launch": { "status": "completed", "output": "Three bullets." }
       }
     }
   }
   ```

   Set `"status": "failed"` there to exercise the failure branch.

3. Before cloud work, run `sapiom_authenticate` and confirm with `sapiom_status`.
   Then `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` →
   `sapiom_dev_agents_run`.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
