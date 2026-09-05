---
"@sapiom/mcp": patch
"@sapiom/harness": patch
---

Name the two Sapiom MCP servers by role in both offline fallbacks — "the local
authoring server" and "the hosted capability server" — instead of by registration
alias, matching the 2.9 authoring primer and the 1.1 Agent Studio system prompt the
backend now serves (SAP-3179).

The two texts disagreed: the Studio prompt called the servers `sapiom` (hosted) and
`sapiom-dev` (local), which is what Studio registers; the authoring primer called them
`sapiom` (local) and `sapiom-direct` (hosted), which is what a plain Claude Code user is
told to register. A Studio session reads both, so "use the `sapiom` alias to author
agents" pointed it at the remote server the prompt had just said not to call while
authoring. Aliases now appear only inside the two `claude mcp add` commands, which are
unchanged. Both digest pins move with the bodies.
