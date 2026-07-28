# Slack Notifier

Post a message to Slack using **your own** credential. This is the "bring your
own API" on-ramp: declare a secret, read it at runtime, call an external service.
Slack is just the concrete hook — the pattern transfers to any API.

## What it does

```
validate  ──▶  post  ──▶  posted   (terminal)
              (fetch)     ├▶  failed    (terminal, on API error)
                          └▶  rejected  (terminal, bot mode with no channel)
validate  ──▶  rejected   (terminal, on bad input)
```

1. **validate** — resolves the message (defaulting to a fixed hello, and rejecting
   anything over the length cap) and the config (auth mode, channel).
2. **post** — reads your credential from the injected environment and calls Slack
   via `fetch`:
   - `bot` mode (default) — a bot token calls `chat.postMessage`; returns the
     resolved channel id + message `ts`.
   - `webhook` mode — an incoming-webhook URL; the channel is baked into the URL.

Input: `{ "message": "Deploy finished :rocket:", "channel": "#general" }`.

## It runs with nothing

Run it with `{}` and it composes the default message, finds no credential, and
terminates with:

```json
{
  "posted": false,
  "skipped": "no-credential",
  "unmet": ["SLACK_BOT_TOKEN"],
  "note": "No `SLACK_BOT_TOKEN` is set, so nothing was posted to Slack. …"
}
```

That is the point. Posting is this template's entire purpose, so with no token it
composes the message, skips the send, and says so — it never reports
`posted: true` for a message nobody received.

## Where the key lives (and how it's injected)

The Slack credential is **never** in code, and the template never names a storage
location. It declares what the credential *is*, in `template.json`:

| Auth mode       | Declared key        | What to supply                                  |
| --------------- | ------------------- | ----------------------------------------------- |
| `bot` (default) | `SLACK_BOT_TOKEN`   | A Slack bot token (`xoxb-…`) with `chat:write`. |
| `webhook`       | `SLACK_WEBHOOK_URL` | A Slack incoming-webhook URL.                   |

Sapiom collects the declared credentials when you use the template, keeps them
scoped to the deployed workflow, and injects them into the step's environment at
dispatch — so `process.env.SLACK_BOT_TOKEN` resolves your secret at runtime with
no extra wiring, and where it is stored can change without touching this template.

Supplying a credential needs no redeploy: secrets are read at step dispatch, so
setting one and re-running is enough.

## Swap Slack for any other API

This template is a shape, not a Slack integration. To notify Discord,
PagerDuty, or your own service instead:

1. In `index.ts`, change the `fetch` URL (and request body) to your API.
2. Change `BOT_TOKEN_KEY` to your credential's key name.
3. Declare that key under `requiredSecrets` in `template.json`.

Everything else — validation, the no-key guard, reading the secret at runtime —
stays the same.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (no network, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → supply your token →
   `sapiom_dev_agents_run` (posts to Slack for real).

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
