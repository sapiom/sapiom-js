---
"@sapiom/agent-core": patch
---

Fix `scaffold` overwriting a template-authored `.npmrc`

`scaffold` renames a template's `_npmrc` to `.npmrc` via `copyTemplate`, then
— when the resolved package versions came from a non-default registry (a
local Verdaccio dev loop) — unconditionally overwrote that `.npmrc` with a
single `@sapiom:registry=...` line. Any content the template had shipped in
`_npmrc` (auth tokens, other registry config) was silently lost.

The registry line is now appended to an existing template-authored `.npmrc`
instead of overwriting it (and skipped if the line is already present), so
template-provided `.npmrc` content survives alongside the dev-loop registry
config. Behavior is unchanged when no template `.npmrc` exists.
