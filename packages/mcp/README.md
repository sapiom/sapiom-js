# @sapiom/mcp

[![npm version](https://img.shields.io/npm/v/@sapiom/mcp)](https://www.npmjs.com/package/@sapiom/mcp)

MCP server that gives Claude Code access to Sapiom services via browser-based authentication.

## Installation

### Option A: Claude Code config

Add the following to `~/.claude/settings.json` (global) or `.claude/settings.json` (project-level):

```json
{
  "mcpServers": {
    "sapiom": {
      "command": "npx",
      "args": ["-y", "@sapiom/mcp"]
    }
  }
}
```

### Option B: CLI command

```sh
claude mcp add sapiom -- npx -y @sapiom/mcp
```

## Available Tools

| Tool | Description |
|------|-------------|
| `sapiom_authenticate` | Open browser to log in to Sapiom |
| `sapiom_status` | Check authentication status |
| `sapiom_logout` | Remove cached credentials |
| `sapiom_verify_send` | Send SMS verification code |
| `sapiom_verify_check` | Verify an SMS code |

## Credential Storage

Credentials are stored at `~/.sapiom/credentials.json` with `0600` permissions (owner read/write only).

## Multi-Environment Support

By default, the server connects to the production environment. To use a different environment, either:

- Set the `SAPIOM_ENVIRONMENT` environment variable, or
- Configure the `environment` field in `~/.sapiom/credentials.json`

## Documentation

Full setup guide and usage details: [docs.sapiom.ai/integration/mcp-servers/claude-code](https://docs.sapiom.ai/integration/mcp-servers/claude-code)

## License

MIT
