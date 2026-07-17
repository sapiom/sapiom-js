---
"@sapiom/harness": patch
---

Show the live run canvas for runs started via the agent tooling, not just the CLI. The run detector now recognizes the run tool's `executionId` result in addition to the CLI's start line, so pressing Prod Run lights up the live step graph. Also stop polling a run whose state can't be fetched after repeated attempts, so a stale or malformed id can't poll indefinitely.
