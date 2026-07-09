---
"@sapiom/cli": minor
---

Add `sapiom dev [dir]` command that launches the Sapiom Harness.

Spawns `sapiom-harness` asynchronously with `stdio: 'inherit'` so the terminal is handed to the harness cleanly. SIGTERM and SIGHUP are forwarded to the child process; SIGINT is intentionally not re-sent (the TTY process group delivers it to both parent and child). If the child exits via a signal the parent exits with 128+signum per POSIX convention; non-zero exit codes are propagated via `process.exitCode`. Unknown flags (future harness flags) pass through verbatim without a CLI update.

`@sapiom/harness` is an optional peer dependency (declared `>=0.1.1 <2`). When absent, a clear install hint is printed. The harness bin is located via `createRequire` bound to `process.argv[1]` so resolution is correct in ESM production; a `__filename` fallback covers the CJS test environment. The `[dir]` positional is never included in analytics payloads.
