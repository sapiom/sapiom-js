---
"@sapiom/agent-core": patch
---

Clone a deployed agent from its stored source, not from git.

A deploy uploads an archive and no longer pushes, so the agent's repo is empty or
frozen at whatever was last committed — a git clone handed back stale code with
nothing to signal it. `clone` now reads the stored archive and extracts it,
preserving nested layouts so relative imports still resolve in the checkout.

Falls back to the git clone on a 404, so an agent that only ever deployed through
the push path — or an engine older than the download route — keeps working.

Adds a tar reader alongside the existing writer. Regular files only: a symlink or
device node is refused rather than skipped, and any path that would escape the
target directory is rejected before anything is written.
