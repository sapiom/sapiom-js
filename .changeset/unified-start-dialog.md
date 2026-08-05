---
"@sapiom/harness": minor
---

Unify the Studio "add" flow into one detection-driven Start dialog.

The rail's `+` and "Create new" used to open a popover of intents that led to a dialog of the same intents — and picking "New session…" or "Open a folder" both dropped you on the identical folder picker. Two different intents, one indistinguishable screen, behind two layers of doors.

Now the `+` opens ONE dialog with ONE folder picker. You point at a folder; Studio detects what it is and the single ink action relabels to the one thing that folder implies: **Add workspace** (an agent project), **Add all N** (a folder of agent projects), or **Scaffold here** (a plain or not-yet-existing folder). The user's intent never overrides the folder's markers, so a folder that is actually an agent project can no longer be silently opened as a bare session.

For an empty or new folder a "Start from" tray offers one calm choice — **Empty**, **Describe an idea** (an inline prompt), or **Templates** (a handoff to the catalog) — with Empty preselected so scaffolding stays the default. A session is always named after the folder basename, shown as a live preview; starting a bare session or registering a plain folder are opt-in secondaries. The `NewSessionModal` and the `AddWorkspaceDialog` door-chooser are removed.

The folder field's **Browse** button now opens the OS-native folder chooser in the desktop app (a new sender-guarded `dialog:choose-directory` IPC), falling back to the in-app directory listing under `npx` — the in-app listing stays either way, since only it can show the "✓ Agent" detection badges.
