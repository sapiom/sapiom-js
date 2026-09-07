---
"@sapiom/agent-core": patch
---

Local `check` and runs now bundle with a `createRequire` banner, so dependencies that call `require()` at runtime (for example `googleapis` / `google-auth-library`) resolve at runtime instead of failing with esbuild's "Dynamic require not supported".
