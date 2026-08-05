---
"@sapiom/harness": minor
---

Replace the rail's header "+" Add-popover — and the `AddWorkspaceDialog` /
`NewSessionModal` doors behind it — with one detection-driven **"Add existing
agents"** dialog, reached from a dedicated rail button (and the new-session
composer's "Open a folder").

Point at a folder and detection relabels the single ink action: **Add workspace**
(the folder is an agent project), **Add all N** (it's a folder of agent
projects), or a disabled "No agent in this folder" when it holds none. No intent
step, no doors, and no way to land on two identical folder-picker screens.
Creating a NEW agent stays with "Create new" (the composer); this dialog only
registers agents that already exist.

The folder field's **Browse** button opens the OS-native folder chooser in the
desktop app (a new sender-guarded `dialog:choose-directory` IPC), falling back to
the in-app directory listing under `npx` — the listing stays either way, since
only it shows the "✓ Agent" detection badges.
