---
"@sapiom/mcp": minor
---

`sapiom_dev_agents_deploy` gains an optional `message` to label a version in the
agent's history.

The tool description no longer claims a git repository with at least one commit
is required — it isn't. Source is uploaded as an archive, and a server with
archives switched off falls back to the old push transparently. That sentence
mattered: an agent reading it would tell a user to run `git init` and `git commit`
before deploying, which is now advice for a requirement that no longer exists.
