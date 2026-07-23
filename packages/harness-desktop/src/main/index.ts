/**
 * Electron main entry for @sapiom/harness-desktop.
 *
 * Second host over the harness's `startServer()` (the npx CLI is the backup).
 * Lifecycle mirrors bin.ts's SIGINT path: on quit we `server.close()` so all
 * live claude/codex PTYs are killed rather than orphaned.
 */
import { app, dialog } from "electron";
import { createSetupWindow } from "./windows.js";
import { boot, type BootResult } from "./boot.js";

const devMode = process.argv.includes("--dev");

// Use overlay scrollbars (like the browser) instead of Chromium's classic
// scrollbars. Classic scrollbars reserve layout width, which pushes the
// harness SPA's 100%-width panels into spurious HORIZONTAL overflow — the
// left/right panels showed scrollbars in Electron but not in the (overlay-
// scrollbar) browser. Must be set before app is ready.
app.commandLine.appendSwitch("enable-features", "OverlayScrollbar");

let bootResult: BootResult | null = null;
let quitting = false;

// Single-instance: focus the existing window instead of booting twice.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = bootResult?.mainWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    const setupWin = createSetupWindow();
    try {
      bootResult = await boot(setupWin, devMode);
      if (devMode) {
        // Dev smoke-test hook: print the tokened URL so a harness can verify
        // the server booted without driving the GUI.
        console.log(`[harness-desktop] ready: ${bootResult.url}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!setupWin.isDestroyed()) {
        setupWin.webContents.send("boot:error", {
          message: "Sapiom failed to start.",
          detail: message,
          retryable: false,
        });
      } else {
        dialog.showErrorBox("Sapiom failed to start", message);
      }
    }
  });
}

// Kill PTYs before exit: intercept quit, close the server, then really quit.
app.on("before-quit", (event) => {
  if (quitting || !bootResult) return;
  event.preventDefault();
  quitting = true;
  void bootResult.server
    .close()
    .catch(() => {
      /* close() is internally race-bounded to 5s; ignore errors on shutdown */
    })
    .finally(() => app.quit());
});

app.on("window-all-closed", () => {
  // The app is the harness window; closing it exits (macOS included for v0 —
  // dock-persist + re-open is a later polish).
  app.quit();
});
