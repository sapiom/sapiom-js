---
"@sapiom/agent-core": patch
---

Fix `scaffold()`'s offline fallback versions (`@sapiom/agent@0.1.1`, `@sapiom/tools@0.1.1`) — neither exists on npm anymore (currently published: `agent@0.5.0`, `tools@0.16.0`). Any scaffold that fell back to these (no network, npm registry unreachable, corporate proxy, etc.) produced a project whose first `npm install` failed with `ETARGET`. Bumped to the current published versions and added a regression test that checks the fallback against the workspace's own package versions, so this can't silently drift again.
