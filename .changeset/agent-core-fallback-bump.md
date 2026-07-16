---
"@sapiom/agent-core": patch
---

fix(agent-core): refresh stale offline scaffold version fallback

`VERSION_FALLBACK` drifted after the last version bump (agent `0.6.2` → `0.6.4`,
tools `0.17.2` → `0.19.0`), so an offline/registry-hiccup scaffold would pin
versions that no longer match what's published. Bumped to match the workspace
package.json, which is what the regression test guards.
