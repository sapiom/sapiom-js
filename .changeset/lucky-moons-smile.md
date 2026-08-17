---
"@sapiom/mcp": patch
---

Enforce 0600 on a pre-existing `~/.sapiom/credentials.json`. `writeFile`'s
`mode` option only applies when the file is created, so a credentials file left
behind with looser permissions kept them while a fresh API key was written into
it. Now chmod'd after the write, matching the CLI session store and
`@sapiom/analytics-core`'s identity store.
