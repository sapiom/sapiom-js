---
"@sapiom/harness": patch
---

Let "Open in editor" target the editor you actually use.

The session menu hardcoded `vscode://file…`, so on a machine with Cursor (or
Windsurf, Zed, VS Code Insiders) and no VS Code the item silently did nothing —
the OS resolves the scheme and never reports back, so an unhandled scheme is
indistinguishable from a working one. Settings now carries an editor picker
(`HarnessSettings.editor`, `PATCH /api/settings`), the menu item names the
chosen editor ("Open in Cursor"), and a toast says where the folder was sent.
Windows paths are normalized to the `/C:/…` shape the handlers expect.
