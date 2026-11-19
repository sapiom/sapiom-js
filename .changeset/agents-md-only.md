---
"@sapiom/agent-core": patch
"@sapiom/cli": patch
"@sapiom/harness": patch
---

Scaffolded agent projects no longer include a `CLAUDE.md`. `AGENTS.md` is the only agent-instruction file in each project; Claude Code reads it directly. Comments that pointed to `CLAUDE.md` now point to `AGENTS.md`.
