---
"@sapiom/harness": minor
"@sapiom/mcp": minor
---

Agent Studio sessions now read Sapiom's served platform authoring rules. On session start the harness fetches `GET /v1/agents/authoring-rules` and inlines the body into the session's copy of the `sapiom-agent-authoring` skill, replacing the bundled summaries, so a rules change reaches Studio without a package release. On any failure, or with `SAPIOM_AUTHORING_RULES_FETCH_DISABLED=1`, the session keeps the bundled skill; the skill's last line names which copy it got (`source: served` or `source: bundled`). `@sapiom/mcp/auth` exports `fetchServedContent`, the one fetch the MCP primer, the Studio system prompt, the drift check and the session skill now share.
