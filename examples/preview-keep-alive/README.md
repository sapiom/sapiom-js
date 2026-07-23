# Preview Keep-Alive

A durable cron heartbeat that **relaunches** a dead sandbox preview — not just
observes it. The missing actuator for Sapiom sandbox previews.

Sapiom sandbox previews are NOT durable always-on hosts: Blaxel recycles the app
process while the sandbox stays "running", so the preview URL 502s until a human
redeploys. A plain `GET /health` cron only observes. This agent redeploys on
failure, entirely on Sapiom's durable cron.

## What it does

```
        ┌──────────▶ healthy  (terminal, no-op)
check ──┤
        └──────────▶ heal ──┬──▶ healed       (terminal)
(fetch probe)               └──▶ heal_failed  (terminal)
                    (sandboxes.attach + sandboxes.deployPreview,
                     env from database.get + vault.get)
```

1. **check** — probes `<url><healthPath>` (default `/health`, 8s timeout). Healthy
   → `healthy` (no-op, so it never stacks a second process onto a live one).
   Down → `heal`.
2. **heal** — re-attaches the sandbox and calls `deployPreview` with source `fs`
   (rebuild + restart the code already uploaded there, same stable URL). The
   relaunch env is `{ PORT, ...env }` plus an optional `DATABASE_URL` from a
   Postgres handle and any `vaultInject` secrets read at runtime.
3. **healed** / **heal_failed** — terminal; report the URL/status or surface the
   `deployPreview` logs.

Heals only a sandbox that still **exists** — its uploaded code is the `fs` that
`deployPreview` rebuilds. A fully deleted sandbox must first be re-created with a
full upload deploy; after that, this keeps it up.

## Multi-target

The target is supplied per-run via the schedule input, so **one** deployed
definition keeps **N** previews alive — one schedule each:

```json
{
  "sandboxName": "my-app",
  "url": "https://your-preview-hash.preview.bl.run",
  "start": "node server.js",
  "port": 3000,
  "dbHandle": "my-app-db",
  "vaultRef": "my-app",
  "vaultInject": { "SAPIOM_API_KEY": "sapiom_api_key" }
}
```

`healthPath` (default `/health`), `build` (default `npm install`), `start`
(default `node server.js`), and `port` (default 3000) fall back to generic
defaults. Secrets named in `vaultInject` are read from the vault at runtime via
`vault.get` — never baked into the schedule or source.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the `heal` step
   inherits that authority to attach the sandbox and read the DB handle / vault.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (pass `{ "dryRun": true, "sandboxName": "my-app", "url": "https://…", "start": "node server.js" }`
   to trace the heal branch offline, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real relaunch against
   a down sandbox).

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
