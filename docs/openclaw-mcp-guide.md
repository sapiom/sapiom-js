# Using Sapiom MCP with OpenClaw

This guide walks you through connecting the Sapiom MCP server to [OpenClaw](https://openclaw.ai/), the open-source AI agent platform. Once configured, your OpenClaw agents can authenticate with Sapiom and send phone verifications — all through natural language.

## Prerequisites

- [OpenClaw](https://docs.openclaw.ai/start/getting-started) installed and running (`openclaw gateway status` shows online)
- Node.js 18+
- A [Sapiom](https://app.sapiom.ai) account

## Quick Start

### 1. Add Sapiom to your OpenClaw config

Open your OpenClaw configuration file:

| Platform | Path |
|----------|------|
| macOS | `~/.clawdbot/clawdbot.json5` |
| Linux | `~/.config/clawdbot/clawdbot.json5` |
| Windows | `%APPDATA%\clawdbot\clawdbot.json5` |

Add the Sapiom MCP server under the `mcp.servers` key:

```json5
{
  // ... existing OpenClaw config ...

  mcp: {
    servers: {
      sapiom: {
        command: "npx",
        args: ["-y", "@sapiom/mcp"],
        env: {}
      }
    }
  }
}
```

### 2. Restart the OpenClaw gateway

After saving the config, restart OpenClaw so it picks up the new MCP server:

```bash
openclaw gateway restart
```

### 3. Authenticate

Message your OpenClaw agent in any connected channel (Slack, Discord, etc.) and ask it to authenticate with Sapiom:

> "Authenticate with Sapiom"

The agent will call the `sapiom_authenticate` tool, which opens a browser login flow at `app.sapiom.ai`. After you sign in, credentials are cached locally at `~/.sapiom/credentials.json` and the agent is ready to use all Sapiom tools.

## Available Tools

Once connected, your OpenClaw agent has access to five tools:

| Tool | Description |
|------|-------------|
| `sapiom_authenticate` | Opens a browser-based login flow. Run once to set up credentials. |
| `sapiom_status` | Checks whether you're authenticated and shows your organization. |
| `sapiom_logout` | Removes cached credentials for the current environment. |
| `sapiom_verify_send` | Sends a 6-digit verification code to a phone number via SMS. |
| `sapiom_verify_check` | Checks a verification code against a verification ID. |

## Usage Examples

### Check authentication status

> "Am I logged into Sapiom?"

The agent calls `sapiom_status` and responds with your organization name and tenant ID, or tells you to authenticate.

### Send a verification code

> "Send a verification code to +15551234567"

The agent calls `sapiom_verify_send` with the phone number (E.164 format) and returns a verification ID.

### Check a verification code

> "The code is 482901"

After a verification has been sent, the agent calls `sapiom_verify_check` with the verification ID and the 6-digit code. It responds with whether the code is valid.

### Full verification flow

A typical end-to-end conversation might look like:

1. **You:** "Verify the phone number +15551234567"
2. **Agent:** "I've sent a verification code to +15551234567. What's the 6-digit code?"
3. **You:** "It's 384710"
4. **Agent:** "Verification successful! The code is correct."

## Configuration Options

### Custom environments

By default, the Sapiom MCP server connects to production (`api.sapiom.ai`). To use a different environment (e.g., staging or local development), set the `SAPIOM_ENVIRONMENT` environment variable:

```json5
{
  mcp: {
    servers: {
      sapiom: {
        command: "npx",
        args: ["-y", "@sapiom/mcp"],
        env: {
          SAPIOM_ENVIRONMENT: "staging"
        }
      }
    }
  }
}
```

Custom environments must be defined in `~/.sapiom/credentials.json`:

```json
{
  "currentEnvironment": "staging",
  "environments": {
    "staging": {
      "appURL": "https://app.staging.sapiom.ai",
      "apiURL": "https://api.staging.sapiom.ai",
      "services": {
        "prelude": "https://prelude.staging.sapiom.ai"
      }
    }
  }
}
```

### Running from source (development)

If you're developing the Sapiom MCP server locally, point OpenClaw at your built output:

```json5
{
  mcp: {
    servers: {
      sapiom: {
        command: "node",
        args: ["/path/to/sapiom-js/packages/mcp/dist/index.js"],
        env: {}
      }
    }
  }
}
```

Build the package first:

```bash
cd packages/mcp
pnpm build
```

## Troubleshooting

### "Not authenticated" errors

If tools return "Not authenticated", run `sapiom_authenticate` first. Ask your agent: "Authenticate with Sapiom."

### Authentication times out

The browser auth flow has a 5-minute timeout. If the browser doesn't open automatically, check the OpenClaw logs for a URL you can open manually.

### Agent doesn't see Sapiom tools

- Verify the MCP server is in your config file under `mcp.servers`
- Restart the OpenClaw gateway after config changes
- Check that `npx -y @sapiom/mcp` runs without errors in your terminal

### Environment issues

If you see `Unknown environment "..."`, make sure the environment is defined in `~/.sapiom/credentials.json` with `appURL`, `apiURL`, and optionally `services.prelude`.
