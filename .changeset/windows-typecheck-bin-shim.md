---
"@sapiom/agent-core": patch
"@sapiom/mcp": patch
---

Fix `check` / `sapiom_dev_agents_check` always failing with `TYPECHECK_FAILED` on Windows

`runTypecheck` ran the project's compiler via the bare `node_modules/.bin/tsc` shim. On Windows that extensionless file is a POSIX sh script (npm ships the real launcher as `tsc.cmd`), which `execFileSync` cannot execute — it threw a spawn error with empty output, so the check reported `TYPECHECK_FAILED` with the generic "Run `tsc --noEmit` for details" hint even when the project's own `tsc --noEmit` passed cleanly. It now runs TypeScript's JS entry (`node_modules/typescript/bin/tsc`) under the current Node binary, which is platform-independent and avoids `.bin`/`.cmd`/PATHEXT/shell entirely.
