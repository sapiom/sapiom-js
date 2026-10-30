---
"@sapiom/mcp": patch
---

`~/.sapiom/credentials.json` is now set to `0600` and its directory to `0700`
on every write, including when they already existed with wider permissions.
Usage analytics for the local-only tools (`sapiom_dev_agents_scaffold`,
`sapiom_dev_agents_check`, `sapiom_dev_agents_run_local`) record each
argument's name and size instead of its value.
