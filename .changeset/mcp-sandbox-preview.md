---
"@sapiom/mcp": patch
---

Add sandbox preview tools to the `sapiom-dev` MCP so a coding agent can build and ship a web app from a local checkout:

- `sapiom_dev_sandbox_configure` — write a validated `type: "sandbox"` resource into `sapiom.json` from typed arguments (the agent fills a schema instead of hand-writing JSON, which it tends to get wrong).
- `sapiom_dev_sandbox_check` — validate the project's sandbox resources without deploying; returns actionable issues.
- `sapiom_dev_sandbox_preview` — provision the sandbox if needed, upload the local code, build, start, and expose a live URL. Returns `{ name, url, status, logs }`.
