---
"@sapiom/harness-desktop": minor
---

Agent Studio now runs on Electron 45, so it requires macOS 13 (Ventura) or later. Every window with a preload is sandboxed, desktop IPC only answers the harness page the app loaded, and other local pages open in a preview window. On Windows, updates install only through "Restart now" until builds are code-signed.
