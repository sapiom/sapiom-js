---
"@sapiom/harness": minor
---

Settings: Display mode — Light / Dark / System.

Choose it in Settings (account menu → Settings, or Sapiom → Settings… / ⌘, in the
desktop app). "System" follows the OS appearance and keeps following it while the
app is open.

The choice is stored in `HarnessSettings.displayMode` (`~/.sapiom/harness/settings.json`,
readable and patchable through `/api/settings`) rather than only in the browser, so it
survives quitting and reopening the desktop app — which serves the SPA from a new
ephemeral port, and therefore a new empty origin store, on every launch. The server
stamps the persisted mode into the served HTML so the first paint is already correct.
Existing installs keep opening dark; "System" is a choice, not the new default.
