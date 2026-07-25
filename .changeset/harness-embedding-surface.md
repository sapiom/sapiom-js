---
"@sapiom/harness": patch
---

Expose the embedding surface so a second host (the Electron desktop app) can reuse the harness instead of forking it: re-export `startServer`/`HarnessServer`/`HarnessServerOptions` plus the setup helpers (`runDoctor`, `pickDefaultHarness`, `ensureAuthenticated`, `getOrCreateMachineId`, `ensureSpawnHelperExecutable`, settings, install-command constants) from the package entry. `saveSettings` is part of that surface: a host that prompts for telemetry consent natively (instead of through the TTY-shaped `ensureConsent`) must persist the answer itself, or the settings file — which the UI's analytics indicator and the next launch both read — never learns about it. No CLI behavior change.

Also run the Canvas step-graph check subprocess correctly when embedded in Electron: it spawns `process.execPath` (the Electron binary when embedded), so it now passes `ELECTRON_RUN_AS_NODE=1` — guarded by `process.versions.electron`, a no-op under the CLI's real Node. And `packageRoot()` (used as the subprocess `cwd`) now translates an `app.asar` path to its `app.asar.unpacked` twin, since a `cwd` inside the asar archive fails with `spawn ENOTDIR` (the host must `asarUnpack` the harness + its deps).
