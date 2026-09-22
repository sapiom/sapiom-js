---
"@sapiom/harness": minor
---

Qualify local MCP commands on each Studio create/resume in both CLI and Desktop.
CLI selects its built runtime dependency only when verified, retaining the
unverified npx @latest fallback. Desktop qualifies its app-managed installation.
Forward private host context only to project sessions; preserve the existing
private map tools/prompts and keep shared map activation off.
