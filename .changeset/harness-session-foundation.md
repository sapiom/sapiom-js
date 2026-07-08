---
"@sapiom/harness": minor
---

New package: the session foundation for the Sapiom agent harness — a `SessionRuntime` interface, a node-pty backed `PtyRuntime` (graceful SIGTERM→SIGKILL kill, lazy native import surfacing a typed `PtyUnavailableError` with remediation hints, automatic repair of non-executable prebuilt spawn-helpers), and a transcript-driven fake-agent fixture used by the harness test suites.
