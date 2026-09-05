---
"@sapiom/harness": minor
---

Deliver a new-agent request directly to Claude Code or Codex at startup after
scaffolding and attachment preparation, without requiring a second Enter or
placing internal authoring instructions in the user's prompt. Preserve project
scope during launch and retain the composer draft when preparation fails.
Session creation and attachment uploads each retain an independent limit of
30 requests per minute, so uploading files does not block a new conversation.

Add optional `CreateSessionRequest.initialPrompt`, `initialAttachments`, and
`scaffold` fields, `LaunchOpts.initialPrompt` for fresh interactive launches,
and `CREATE_SESSION_JSON_LIMIT_BYTES` for embedders configuring HTTP parsers.
Export `PROJECT_AGENT_PROMPT_APPENDIX` and `projectAgentPromptAppendix` so
embedders can compose Studio's shared project guidance and optional focused
context offline without starting a server.

Strengthen shared Agent Map, build-plan, and writable subsession guidance while
keeping authoring and runtime capabilities primary. Document project-tool
contracts and replace the known stale Studio orientation at prompt delivery.
