---
"@sapiom/harness": patch
---

Fix fresh Codex delegation waiting for a transcript that Codex creates only after the first turn. Exact owned children now receive one marked kickoff before transcript discovery, and concurrent rollouts are correlated to that runtime without crossing session identities. Retried requests preserve the same child and do not repeat its kickoff.
