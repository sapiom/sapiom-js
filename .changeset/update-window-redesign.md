---
"@sapiom/harness-desktop": patch
---

Replace the native "update ready" dialog with a designed, on-brand update window

electron-updater's "Sapiom X is ready to install" prompt was a native OS dialog — unstyleable and generic. It's now a custom frameless window, built the same way as the setup window (bundled, CSP-locked HTML themed through the design-system seam), so it reads as Sapiom instead of a system alert.

- **Design:** the Sapiom "S" mark (in a neutral ink chip) + wordmark + `agent.studio <version>` lockup, a concise "`<version>` is ready to install. Restart ends running agent sessions." line, and an ink primary **Restart now** with secondary **Later** and **Skip this version**. Light and dark.
- **Skip this version** is persisted (a desktop-local `update-prefs.json`): that version is never re-offered, a newer one still is, and "Check for updates" clears skips.
- **Automatically download and install updates** toggle: when on (the default), a downloaded update installs on the next ordinary quit (`autoInstallOnAppQuit`) — never a surprise mid-session restart; off keeps the prompt-only behaviour. This reverses the former hardcoded no-auto-install default, now that the user controls it.
- **Theme sync:** the window follows the app's current light/dark theme. Its `file://` origin can't read the SPA's (`http://localhost`) theme storage, so the main process reads the SPA window's live `data-theme` and hands it in — no drift to the OS default when the user has picked a non-OS theme.
- **Safety preserved:** "Later" is the keyboard default (Esc/Return defer); restarting needs an explicit click. The new IPC channels are scoped to the update window's own renderer (sender-gated, registered only while it is open), so page/agent content still cannot trigger a restart.
