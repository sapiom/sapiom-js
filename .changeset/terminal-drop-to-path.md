---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

Restore drag-and-drop of images (and any file) into the Studio terminal. Removing the image composer (#562) left drops with no handler at all — xterm.js has no native drop behavior, so in the desktop app a dropped image was handed to the OS viewer instead of the agent. A drop on the terminal now behaves like a native emulator: the desktop preload resolves the dropped File to its real path (`webUtils.getPathForFile`) and the SPA pastes the quoted path into the pty, which Claude/Codex pick up natively (`[Image #1]`). Stray drops elsewhere in the SPA no longer navigate the page away.
