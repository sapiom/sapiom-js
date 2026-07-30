---
"@sapiom/agent-core": patch
---

Update the scaffold offline `VERSION_FALLBACK` to the currently published versions (`@sapiom/agent@0.7.1`, `@sapiom/tools@0.23.0`). The previous values had drifted behind the last release, which failed the "fallback matches the workspace version" regression test in `scaffold.test.ts`. Keeping the fallback current means an offline / registry-hiccup scaffold resolves to a version that actually exists on npm instead of failing with a silent ETARGET.
