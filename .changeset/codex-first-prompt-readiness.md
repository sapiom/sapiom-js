---
"@sapiom/harness": patch
---

Release held Agent Studio prompts into Codex once its terminal has rendered a
settled frame with no recognized blocking screen. Initial prompts remain held
through Codex trust, sign-in, and setup flows, and Claude Code's SessionStart
readiness behavior is unchanged. Codex may now report `ready: true` before its
first rollout/transcript exists: readiness describes an input-safe TUI, not
durable conversation metadata.
