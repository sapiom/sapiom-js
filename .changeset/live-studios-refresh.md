---
"@sapiom/mcp": minor
"@sapiom/harness": minor
---

Resolve the latest saved credential and selected environment whenever Agent Studio creates, resumes, or runs a background Claude session. A confirmed credential removal now clears the launch key, while a malformed or unreadable store preserves the last-known key. Unknown selected environments now fail the affected launch with an explicit configuration error instead of silently routing it to production. Preserve `--no-auth` as a process-wide opt-out and expose a strict credential-store reader for safe live reconciliation.
