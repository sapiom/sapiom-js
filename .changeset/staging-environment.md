---
"@sapiom/cli": minor
"@sapiom/mcp": minor
---

Add a `staging` environment to host resolution. `resolveHost` maps the `staging` target (alias `dev`) to the staging API host, and the MCP server resolves `SAPIOM_ENVIRONMENT=staging`/`dev`/`prod` from built-in presets without requiring a `~/.sapiom/credentials.json` entry. A file-defined environment still takes precedence.
