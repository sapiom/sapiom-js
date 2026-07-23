# Slack Notifier

Post a message to Slack using **your own** credential, stored in the Sapiom
Vault. This is the "bring your own API" on-ramp: store a secret, read it at
runtime, call an external service. Slack is just the concrete hook — the pattern
transfers to any API.

## What it does

```
validate  ──▶  post  ──▶  posted   (terminal)
              (vault +    ├▶  failed    (terminal, on API error)
               fetch)     └▶  ...
validate  ──▶  rejected   (terminal, on bad input)
```

1. **validate** — checks the message (non-empty, under the length cap) and
   resolves config (auth mode, channel). Bad input → `rejected`.
2. **post** — reads your credential with `ctx.sapiom.vault.get("slack", ...)`
   and calls Slack via `fetch`:
   - `bot` mode (default) — a bot token calls `chat.postMessage`; returns the
     resolved channel id + message `ts`.
   - `webhook` mode — an incoming-webhook URL; the channel is baked into the URL.

Input: `{ "message": "Deploy finished :rocket:", "channel": "#general" }`.

## Where the key lives (and how it's injected)

The Slack credential is **never** in code. It lives in the Sapiom Vault, scoped
to this workflow (`workflow:{definitionId}`), under the ref `slack`:

| Auth mode        | Vault key     | What to store                                   |
| ---------------- | ------------- | ----------------------------------------------- |
| `bot` (default)  | `bot_token`   | A Slack bot token (`xoxb-…`) with `chat:write`. |
| `webhook`        | `webhook_url` | A Slack incoming-webhook URL.                   |

On `deploy`, the agent is authorized to read the Vault via the injected
`SAPIOM_API_KEY` leaf token, so `ctx.sapiom.vault.get(...)` resolves your secret
at runtime with no extra wiring.

Set the token after deploy (until the in-UI "set a secret at creation" flow
lands):

```bash
curl -X POST "$SAPIOM_API_URL/workflows/definitions/$DEFINITION_ID/secrets" \
  -H "Authorization: Bearer $SAPIOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "ref": "slack", "secrets": { "bot_token": "xoxb-your-token" } }'
```

## Swap Slack for any other API

This template is a shape, not a Slack integration. To notify Discord,
PagerDuty, or your own service instead:

1. In `index.ts`, change the `fetch` URL (and request body) to your API.
2. Change `VAULT_REF` / the secret key to match your credential.
3. Store your API's key in the Vault under that ref (same `POST .../secrets`).

Everything else — validation, the `dryRun` / no-key guard, reading the secret at
runtime — stays the same.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the `post` step
   inherits that authority to read the Vault.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (Vault stubbed, no
   network, free) → `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → set
   your token (above) → `sapiom_dev_agents_run` (posts to Slack for real).

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
