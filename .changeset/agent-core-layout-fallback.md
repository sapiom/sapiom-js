---
"@sapiom/agent-core": patch
---

Fall back to the git transport when an agent's layout cannot be archived.

An agent importing code from outside its own directory (a shared `kit/` a level
up) deployed fine via the push path, because esbuild inlined those files. It now
falls back instead of failing, so an author who upgrades the SDK does not lose a
layout that previously worked. The transport metric still records these as `git`,
so the remaining work stays visible rather than hidden.
