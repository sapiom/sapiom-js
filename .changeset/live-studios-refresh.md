---
"@sapiom/mcp": patch
"@sapiom/harness": patch
---

Resolve the latest saved credential and selected environment whenever Agent Studio creates, resumes, or runs a background Claude session. Preserve `--no-auth` as a process-wide opt-out and expose a strict credential-store reader for safe live reconciliation.
