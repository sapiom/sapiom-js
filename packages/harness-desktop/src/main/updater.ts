/**
 * In-place app updates.
 *
 * The harness ships *inside* this bundle, so without this module a harness fix
 * reaches a desktop user only if they find, download and run a new installer —
 * which testers do not do. They sit on a broken build and re-report bugs we
 * already fixed. electron-updater replaces the whole app, which means an update
 * also carries Electron and node-pty (and their security fixes), not just our JS.
 *
 * The policy decisions — which channel, whether to check at all — live in
 * `update-policy.ts`, which imports neither `electron` nor `electron-updater` so
 * it can be unit-tested (see `vitest.config.ts` on why nothing here is mocked).
 * This module is the wiring, and is covered by the packaged `--smoke` run.
 *
 * ## Two traps encoded below
 *
 * 1. `import { autoUpdater } from "electron-updater"` does not work. The package
 *    is CommonJS and exposes `autoUpdater` as a getter, which `cjs-module-lexer`
 *    cannot see statically, so ESM link fails outright:
 *      SyntaxError: Named export 'autoUpdater' not found.
 *    A default import and a property read is the supported form. The read is also
 *    kept LAZY: the getter constructs a platform updater (and pulls in electron),
 *    so touching it at module scope would run that work during import, before we
 *    know whether the updater is even enabled.
 *
 * 2. Applying an update must close the harness server FIRST. `quitAndInstall`
 *    can hand off to the NSIS installer before an async `before-quit` handler has
 *    finished, which would leave live `claude` processes holding files the
 *    installer is trying to replace. So the update path calls the caller's
 *    `shutdown()` and awaits it, rather than relying on the quit hook.
 */
import { BrowserWindow, app, dialog } from "electron";
// CJS: default-import then read the property. See trap 1 above.
import electronUpdater from "electron-updater";
import type { UpdateInfo } from "electron-updater";
import {
  CHANNEL_ENV_VAR,
  resolveUpdateChannel,
  shouldEnableUpdater,
} from "./update-policy.js";

/**
 * How often to look for a new build. Four hours: the app is a long-lived desktop
 * session, and an update that lands during the working day should be offered the
 * same day without turning into a poll loop.
 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

/**
 * Delay before the first check. The boot sequence has just finished and the user
 * is looking at a freshly-loaded SPA; a network round-trip and a possible dialog
 * belong after that, not during it.
 */
const FIRST_CHECK_DELAY_MS = 30 * 1_000;

export interface UpdaterDeps {
  mainWindow: BrowserWindow;
  devMode: boolean;
  smoke: boolean;
  /**
   * Closes the harness server, killing every live PTY. Supplied by `index.ts`,
   * which owns app lifecycle and memoizes it so the quit hook and this module
   * cannot close it twice.
   */
  shutdown: () => Promise<void>;
}

function log(message: string): void {
  // Unconditional and on stderr: these lines are rare, and they are the only
  // evidence available when a user reports "it never updates". Gating them behind
  // a debug flag would mean the one time we need them, they aren't there.
  console.error(`[updater] ${message}`);
}

/** Versions the user has already said "Later" to during this run — see below. */
const declined = new Set<string>();
let promptOpen = false;

/**
 * Offer the update, and apply it only if the user agrees.
 *
 * A native dialog rather than something injected into the page: the main window
 * shows the harness SPA, served by the harness itself, and reaching into it would
 * couple this app to a UI another person is actively refactoring. It also matches
 * how the rest of onboarding already talks to the user.
 *
 * Declining is remembered per version FOR THIS RUN only. Re-prompting on every
 * check would nag someone who already said no; forgetting entirely across
 * launches would mean a deferred update is never mentioned again. Prompting once
 * per launch is the middle that needs no extra state on disk.
 */
async function offerUpdate(info: UpdateInfo, deps: UpdaterDeps): Promise<void> {
  const { version } = info;
  if (declined.has(version) || promptOpen) return;
  if (deps.mainWindow.isDestroyed()) return;

  promptOpen = true;
  try {
    const { response } = await dialog.showMessageBox(deps.mainWindow, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Sapiom ${version} is ready to install.`,
      // The session warning is the point of this dialog, not a footnote: the
      // user may have an agent mid-task, and restarting ends it. Burying that is
      // how a well-meaning update destroys someone's work.
      detail:
        "Restarting will end any running agent sessions. " +
        "Choose Later to keep working — Sapiom stays on the current version until you restart.",
    });
    if (response !== 0) {
      declined.add(version);
      log(`user deferred ${version}`);
      return;
    }
  } finally {
    promptOpen = false;
  }

  log(`applying ${version} — closing the harness server first`);
  // Await it: see trap 2. An orphaned pty holding the install directory is a
  // failed update on Windows, and an orphaned `claude` on every platform.
  await deps.shutdown();
  // (true, true) = install without the NSIS wizard, then relaunch. Both are
  // Windows-only knobs; macOS always relaunches and Linux ignores them. Without
  // isForceRunAfter a "Restart now" would quit and NOT come back, which is not
  // what the button says.
  electronUpdater.autoUpdater.quitAndInstall(true, true);
}

/**
 * Wire up update checking. Safe to call unconditionally — it decides for itself
 * whether to do anything, and NEVER throws.
 *
 * That last part is structural, not a promise: the call site sits inside boot's
 * own try/catch, so an escaping error here would be reported to the user as
 * "Sapiom failed to start". Updates are a convenience; failing to arrange them
 * must never cost someone their app.
 */
export function initUpdater(deps: UpdaterDeps): void {
  try {
    startUpdater(deps);
  } catch (err) {
    log(`could not initialise: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function startUpdater(deps: UpdaterDeps): void {
  const gate = shouldEnableUpdater({
    isPackaged: app.isPackaged,
    devMode: deps.devMode,
    smoke: deps.smoke,
    env: process.env,
  });
  if (!gate.enabled) {
    log(`disabled — ${gate.reason}`);
    return;
  }

  const decision = resolveUpdateChannel(app.getVersion(), process.env);
  if (decision.ignoredOverride) {
    log(`ignoring ${CHANNEL_ENV_VAR}="${decision.ignoredOverride}" — expected "latest" or "beta"`);
  }

  // Reading the getter constructs a platform-specific updater and can throw
  // outright (an unsupported packaging format, for one) — which is one of the
  // reasons initUpdater wraps this whole function.
  const { autoUpdater } = electronUpdater;

  autoUpdater.channel = decision.channel;
  autoUpdater.allowPrerelease = decision.allowPrerelease;
  autoUpdater.autoDownload = true;
  // We own the restart (the user asked to be notified, not surprised), so an
  // ordinary quit must NOT install. Leaving this at its default would apply the
  // update on quit — silently — which is the behaviour we deliberately declined.
  autoUpdater.autoInstallOnAppQuit = false;
  // Only when forced on from an unpackaged build: read dev-app-update.yml
  // instead of the app-update.yml that only packaging writes.
  if (gate.forced) autoUpdater.forceDevUpdateConfig = true;

  autoUpdater.logger = {
    info: (m) => log(String(m)),
    warn: (m) => log(`warn: ${String(m)}`),
    error: (m) => log(`error: ${String(m)}`),
    debug: () => {},
  };

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    log(`${info.version} available on "${decision.channel}" — downloading`);
  });
  autoUpdater.on("update-not-available", () => {
    log(`up to date on "${decision.channel}" (${app.getVersion()})`);
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    void offerUpdate(info, deps).catch((err: unknown) => {
      log(`failed to apply ${info.version}: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  autoUpdater.on("error", (err) => {
    // Expected in the field, and never fatal: no network, a release without
    // metadata, an AppImage the user extracted, a .deb with no working package
    // manager. The app keeps working on the version it has.
    log(`check failed: ${err.message}`);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      // checkForUpdates rejects AND emits "error"; swallow here so the
      // rejection can't surface as an unhandled promise.
      log(`check rejected: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  log(
    `enabled — channel "${decision.channel}", allowPrerelease=${decision.allowPrerelease}` +
      `${gate.forced ? ", forced (dev config)" : ""}`,
  );
  // .unref() so a pending check can't hold the process alive during quit.
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}
