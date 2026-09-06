---
"@sapiom/harness-desktop": patch
"@sapiom/harness": patch
---

Check installed Claude Code and Codex CLIs for updates before desktop sessions
start, so an old local CLI does not keep Studio users on an outdated model
picker. Install updates into isolated Studio-owned directories, verify the
executable before selecting it, and preserve the working version when updates
fail or the device is offline. Existing provider configuration, sign-in, and
conversation history are preserved.

The harness adapters now accept optional interpreter arguments and environment
overrides, and export `createCodexAdapter`, so a desktop host can launch a
managed JavaScript CLI using its bundled runtime on Windows without system Node.
