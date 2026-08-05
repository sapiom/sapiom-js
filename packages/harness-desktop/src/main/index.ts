/**
 * Electron main entry for @sapiom/harness-desktop.
 *
 * Second host over the harness's `startServer()` (the npx CLI is the backup).
 * Lifecycle mirrors bin.ts's SIGINT path: on quit we `server.close()` so all
 * live claude/codex PTYs are killed rather than orphaned.
 */
// FIRST, and it has to stay first: this pins esbuild's native binary to a path
// outside app.asar, and esbuild reads that setting once, when its own module is
// evaluated. Every import below reaches @sapiom/harness → agent-core → esbuild,
// so anything ahead of this line makes a packaged deploy fail with
// `spawn ENOTDIR`. See esbuild-binary.ts.
import "./esbuild-binary.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { app, dialog, Menu } from "electron";
import { resolveInstanceLockAction } from "./single-instance.js";
import { createSetupWindow } from "./windows.js";
import { boot, type BootResult } from "./boot.js";
import { runSmokeChecks, reportSmoke } from "./smoke.js";
import { initUpdater } from "./updater.js";
import { initDialogs } from "./dialogs.js";
import { setTrustedWindow } from "./trusted-sender.js";
import { parseDeepLink, deepLinkFromArgv, DEEP_LINK_SCHEME } from "./deep-link.js";
import { DEEP_LINK_NAVIGATE } from "./ipc.js";

const devMode = process.argv.includes("--dev");
/** `--smoke`: boot, verify the packaged bundle, print results, exit. See smoke.ts. */
const smokeMode = process.argv.includes("--smoke");

// Use overlay scrollbars (like the browser) instead of Chromium's classic
// scrollbars. Classic scrollbars reserve layout width, which pushes the
// harness SPA's 100%-width panels into spurious HORIZONTAL overflow — the
// left/right panels showed scrollbars in Electron but not in the (overlay-
// scrollbar) browser. Must be set before app is ready.
app.commandLine.appendSwitch("enable-features", "OverlayScrollbar");

let bootResult: BootResult | null = null;
let quitting = false;
/**
 * Memoized server shutdown, shared by the quit hook and the updater.
 *
 * Both paths need the PTYs dead, and they can race: applying an update calls this
 * directly (see updater.ts — `quitAndInstall` can hand off to the NSIS installer
 * before an async `before-quit` completes), and `quitAndInstall` then quits, which
 * fires `before-quit`. Memoizing means the second caller awaits the first close
 * instead of starting a second one against an already-closing server.
 */
let shuttingDown: Promise<void> | null = null;
function shutdownServer(): Promise<void> {
  if (!bootResult) return Promise.resolve();
  // Set synchronously, before any await: the quit hook reads it to decide whether
  // to intercept, and a later assignment would let it intercept its own re-quit.
  quitting = true;
  shuttingDown ??= bootResult.server.close().catch(() => {
    /* close() is internally race-bounded to 5s; ignore errors on shutdown */
  });
  return shuttingDown;
}

/**
 * A `sapiom://` deep link buffered until the main window can receive it (no
 * window yet, or its first page still loading). Consumed by the cold-start query
 * param (boot) or the did-finish-load flush below.
 */
let pendingDeepLink: string | null = null;

/** Deliver a received deep link: focus the window and push the target, or buffer it. */
function handleDeepLink(rawUrl: string): void {
  const target = parseDeepLink(rawUrl);
  if (!target) return; // not one of ours — ignore
  const win = bootResult?.mainWindow;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send(DEEP_LINK_NAVIGATE, target);
  } else {
    pendingDeepLink = rawUrl;
  }
}

/**
 * Register Studio as the OS handler for `sapiom://`. Skipped under --smoke (CI
 * must not mutate LaunchServices/HKCU). electron-builder writes the macOS
 * Info.plist + Linux .desktop entries at package time; this call covers Windows
 * (HKCU) and the unpackaged `pnpm dev` case.
 */
function registerDeepLinkScheme(): void {
  if (smokeMode) return;
  if (process.defaultApp) {
    // Unpackaged: Electron itself is the launcher, so register execPath + entry.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
}

// Single-instance: focus the existing window instead of booting twice — except
// under --smoke, where losing the lock means the run verified NOTHING and must
// say so instead of exiting 0. See single-instance.ts.
const lock = resolveInstanceLockAction({
  gotLock: app.requestSingleInstanceLock(),
  smokeMode: smokeMode,
});
if (lock.action === "fail") {
  console.log(lock.message);
  const outFile = process.env.SAPIOM_SMOKE_OUT;
  if (outFile) {
    // Same reason reportSmoke writes this file: on Windows a GUI-subsystem exe
    // has no console to print to, so stdout alone loses the diagnostic.
    try {
      writeFileSync(outFile, lock.message + "\n", "utf8");
    } catch {
      /* nothing better to do — the exit code still fails the run */
    }
  }
  app.exit(lock.exitCode);
} else if (lock.action === "quit") {
  app.quit();
} else {
  registerDeepLinkScheme();
  // macOS delivers deep links to the primary instance via open-url, and it can
  // fire BEFORE whenReady on a cold start — register at top level so the handler
  // buffers into pendingDeepLink until the window exists.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  app.on("second-instance", (_event, argv) => {
    const win = bootResult?.mainWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Windows/Linux deliver a deep link as an argv token to this second launch.
    const link = deepLinkFromArgv(argv);
    if (link) handleDeepLink(link);
  });

  app.whenReady().then(async () => {
    // No application menu — the harness SPA is the whole UI. Removes the
    // File/Edit/View/Window/Help bar on Linux/Windows. (On macOS the top menu
    // bar is OS-level and can't be removed; this leaves a bare default there —
    // a proper minimal macOS menu with edit roles can be added in the mac phase.)
    Menu.setApplicationMenu(null);
    const setupWin = createSetupWindow();
    try {
      // A deep link present at cold start — a macOS open-url already buffered, or
      // the URL in Windows/Linux argv — rides onto the SPA load URL as ?agent=.
      const coldLink = pendingDeepLink ?? deepLinkFromArgv(process.argv);
      pendingDeepLink = null;
      const coldTarget = coldLink ? parseDeepLink(coldLink) : null;
      bootResult = await boot(setupWin, { devMode, smoke: smokeMode, deepLink: coldTarget ?? undefined });
      if (devMode || smokeMode) {
        // Dev/smoke hook: print the tokened URL so a harness can verify the
        // server booted without driving the GUI.
        console.log(`[harness-desktop] ready: ${bootResult.url}`);
      }
      // BEFORE the smoke branch, deliberately. initUpdater gates itself on
      // packaged/!dev/!smoke — it starts no timers and touches no network under
      // --smoke — but it also registers the IPC handlers the SPA's "Check for
      // updates" button invokes. Calling it only on the non-smoke path left the
      // smoke run with no handler, so the packaged check could not exercise the
      // real wiring: it failed with "No handler registered for 'update:check'"
      // against an app that works fine in production. Handler registration must
      // not depend on where in this sequence we happen to return.
      // The main window's renderer is the ONLY trusted origin for privileged IPC
      // (update checks, the native folder picker). Set it before registering any
      // handler that validates the sender, and on every boot path — including
      // --smoke, which round-trips the bridge to prove the wiring.
      setTrustedWindow(bootResult.mainWindow);
      initUpdater({
        mainWindow: bootResult.mainWindow,
        devMode,
        smoke: smokeMode,
        shutdown: shutdownServer,
      });
      // Native OS dialogs (the folder picker behind Browse). Registered here for
      // the same reason as initUpdater: invoke on an unhandled channel rejects, so
      // the handler must exist regardless of which branch of boot we exit through.
      initDialogs({ mainWindow: bootResult.mainWindow });
      if (smokeMode) {
        // Verify the packaged bundle, then leave — never wait for a user. The
        // exit code is the CI signal. `app.exit` skips the before-quit handler,
        // so close the server here (it kills any live PTY); don't destroy the
        // windows first, or window-all-closed → quit → before-quit would close
        // the server a second time.
        const code = reportSmoke(await runSmokeChecks(bootResult));
        await shutdownServer();
        app.exit(code);
        return;
      }
      // A deep link that landed during the load gap (window created, first page
      // not yet finished) was buffered — deliver it once the SPA is ready. Only
      // on the non-smoke path; the smoke branch returned above.
      bootResult.mainWindow.webContents.once("did-finish-load", () => {
        const buffered = pendingDeepLink;
        pendingDeepLink = null;
        if (buffered) handleDeepLink(buffered);
      });
    } catch (err) {
      if (smokeMode) {
        // A boot failure IS the smoke result — report it as one and fail fast
        // rather than showing an error window nobody is watching.
        console.error(`[smoke] FAIL boot — ${err instanceof Error ? err.message : String(err)}`);
        console.log("[smoke] FAILED — boot did not complete");
        app.exit(1);
        return;
      }
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
  void shutdownServer().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  // The app is the harness window; closing it exits (macOS included for v0 —
  // dock-persist + re-open is a later polish).
  app.quit();
});
