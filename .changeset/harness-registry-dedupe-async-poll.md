---
"@sapiom/harness": patch
---

Internal robustness fixes (no behavior change for users):

- Serialize WorkflowRegistry writes through a promise queue so concurrent prune/scan/connectPath calls can't interleave and drop entries from workflows.json.
- Thread the resolved workflow path from the macros router into background task requests so TaskManager can dedupe per-workflow across sessions, not just per-session.
- Make the workspace-watcher polling fallback walk async (fs/promises) to avoid blocking the event loop on wide directories; lengthen the poll interval to 2 s.
