# Assistant completion/status evidence

Captured on 2026-09-10 from the real Studio server and pinned OpenCode runtime in an isolated scratch workspace. Model responses and the read-only MCP endpoint are deterministic fixtures; OpenCode executes actual file writes, shell commands, and Node tests. This verifies integration and presentation, not general model completion reliability.

- before.png: two completed tool steps and a preamble, with no overall outcome.
- working.png: bounded native continuation is visibly working.
- finished.png: files created, three Node tests passed, explanation shown, Finished reported.

The native test also verifies one original action, one MCP invocation, same-conversation follow-up, and preserved history/status after reload and Terminal exit.
