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
import { BrowserWindow, app, dialog, ipcMain } from "electron";
// CJS: default-import then read the property. See trap 1 above.
import electronUpdater from "electron-updater";
import type { UpdateInfo } from "electron-updater";
import { UPDATE_CHECK, UPDATE_STATE, type UpdateCheckOutcome, type UpdateStatePayload } from "./ipc.js";
// Shared with the folder-picker channel — the "only the SPA at `/` may ask" rule
// lives in one place rather than being copied per privileged channel.
import { isTrustedSender } from "./trusted-sender.js";
import {
  CHANNEL_ENV_VAR,
  classifyUpdateError,
  resolveUpdateChannel,
  shouldEnableUpdater,
} from "./update-policy.js";
// The custom "update ready" window that replaced the native offer dialog.
import { showUpdatePrompt } from "./update-window.js";
// Persisted, desktop-only update prefs: the auto-install toggle + skipped versions.
import {
  DEFAULT_UPDATE_PREFS,
  addSkippedVersion,
  clearSkippedVersions,
  loadUpdatePrefs,
  saveUpdatePrefs,
  updatePrefsPathIn,
} from "./update-prefs.js";

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
 * Who we serve, set on every launch regardless of the gate.
 *
 * Separate from `active` on purpose: sender validation and the failure dialogs
 * need the main window even when updates are switched off. Deriving the window
 * from `active` instead made `isTrustedSender` reject *everything* in a build with
 * updates disabled, so the SPA reported the useless "not available here" in place
 * of the real reason ("not a packaged build").
 */
let host: UpdaterDeps | null = null;
/** Live updater, once initialised. Null means checks are off — `disabledReason` says why. */
let active: { autoUpdater: typeof electronUpdater.autoUpdater; channel: string; deps: UpdaterDeps } | null = null;
let disabledReason: string | null = null;
/**
 * An update that has finished downloading and is waiting for a restart. Held so
 * an on-demand check can answer "ready — restart" instead of "up to date", which
 * is what it would otherwise say: electron-updater reports the *installed*
 * version, and a downloaded-but-unapplied update doesn't change that.
 */
let pending: UpdateInfo | null = null;
/** In-flight on-demand check, so a double-click doesn't start two. */
let checkInFlight: Promise<UpdateCheckOutcome> | null = null;

/**
 * How long to wait for `quitAndInstall` to actually end the process before
 * concluding the handoff failed. It normally quits within a second; 15s is slack
 * for Squirrel.Mac's staging step, not a guess at a happy path.
 */
const HANDOFF_GRACE_MS = 15 * 1_000;

/**
 * Tell the SPA whether its "Update now" card should exist — the state that
 * mirrors `pending`. Push-only (see UPDATE_STATE in ipc.ts): the card's click
 * comes back through the existing UPDATE_CHECK invoke, so this adds no
 * privileged surface. Called on `update-downloaded`, on a failed apply (to
 * retract), and on every `did-finish-load` so a reloaded page re-learns what
 * the main process still knows.
 */
function pushUpdateState(): void {
  const win = host?.mainWindow;
  if (!win || win.isDestroyed()) return;
  const payload: UpdateStatePayload = pending
    ? { kind: "downloaded", version: pending.version }
    : { kind: "none" };
  // Rare and load-bearing when a user reports "the card never shows" — same
  // rationale as every other line this module logs.
  log(`card state → ${payload.kind === "downloaded" ? payload.version : "none"}`);
  win.webContents.send(UPDATE_STATE, payload);
}

/**
 * Dev-only preview twin of SAPIOM_PREVIEW_UPDATE_WINDOW (see index.ts): fake a
 * downloaded update so the rail's "Update now" card can be eyeballed without a
 * real release. Only `version` is ever read off `pending` on this path (the
 * card push and the on-demand check's `downloaded` answer), so the sparse cast
 * is honest — and clicking the card in an unpackaged build answers `disabled`,
 * which is the truth. Never called outside the devMode gate.
 */
export function previewDownloadedUpdateCard(version: string): void {
  pending = { version } as UpdateInfo;
  pushUpdateState();
}

/**
 * Hand off to the platform installer, having first closed the harness server.
 *
 * Two hard-won constraints pull in opposite directions here:
 *
 *  - The server MUST close before the installer runs (trap 2 at the top): an
 *    orphaned pty holding the install directory is a failed update on Windows,
 *    and an orphaned `claude` everywhere.
 *  - But closing it kills every agent session, and `quitAndInstall` is NOT
 *    guaranteed to quit. Squirrel.Mac refuses an update it cannot verify, and the
 *    mac build is unsigned whenever `CSC_LINK` is absent; an extracted AppImage
 *    and a `.deb` with no usable package manager can't self-install either. This
 *    file's own error handler lists all three as things that happen in the field.
 *
 * Doing the irreversible half first meant that in every one of those cases the
 * user lost their work AND stayed on the old version, looking at a dead SPA, with
 * one stderr line as the only evidence. So: refuse up front when the updater
 * cannot install, and if the handoff still doesn't happen, relaunch rather than
 * leave a hollow app.
 */
async function applyUpdate(version: string): Promise<{ ok: boolean; reason?: string }> {
  if (!active) return { ok: false, reason: "updates are not initialised" };

  // Checked BEFORE touching the server, because this is the whole point: no
  // installer, no reason to take anything away from the user.
  if (!active.autoUpdater.isUpdaterActive()) {
    log(`refusing to apply ${version}: the updater is not active for this install`);
    return {
      ok: false,
      reason:
        "This build can't install updates itself — it's unsigned, or installed in a format " +
        "that can't self-update. Download the new version instead; your sessions are untouched.",
    };
  }

  log(`applying ${version} — closing the harness server first`);
  await active.deps.shutdown();
  try {
    // (true, true) = install without the NSIS wizard, then relaunch. Both are
    // Windows-only knobs; macOS always relaunches and Linux ignores them. Without
    // isForceRunAfter a "Restart now" would quit and NOT come back, which is not
    // what the button says.
    active.autoUpdater.quitAndInstall(true, true);
  } catch (err) {
    log(`quitAndInstall threw: ${err instanceof Error ? err.message : String(err)}`);
    relaunchAfterFailedHandoff();
    return { ok: false, reason: "The installer could not be started; restarting Sapiom." };
  }

  // Still running after the grace period means the handoff silently failed — and
  // the server is already closed, so there is nothing to go back to. Relaunching
  // on the OLD version is a worse outcome than updating and a much better one than
  // an app with no server behind it.
  setTimeout(() => {
    log("quitAndInstall did not quit — relaunching on the current version");
    relaunchAfterFailedHandoff();
  }, HANDOFF_GRACE_MS).unref();
  return { ok: true };
}

function relaunchAfterFailedHandoff(): void {
  // `pending` is cleared by the caller; this process is about to be replaced.
  app.relaunch();
  app.exit(0);
}

/** The persisted-prefs file for this install (Electron's per-user userData dir). */
function updatePrefsFile(): string {
  return updatePrefsPathIn(app.getPath("userData"));
}

/**
 * Persist an "auto-install on quit" toggle change AND apply it live. Passed to the
 * update window (which holds no autoUpdater reference); the window calls it the
 * moment the toggle flips, so the change sticks even if the user then just closes
 * the window rather than pressing a button.
 */
async function setAutoUpdatePref(on: boolean): Promise<void> {
  const prefs = await loadUpdatePrefs(updatePrefsFile());
  await saveUpdatePrefs({ ...prefs, autoUpdate: on }, updatePrefsFile());
  if (active) active.autoUpdater.autoInstallOnAppQuit = on;
  log(`auto-install on quit ${on ? "enabled" : "disabled"} by user`);
}

/**
 * Offer the update, and act on the user's choice.
 *
 * A custom window (see `update-window.ts`), not something injected into the page:
 * this fires whenever a background download finishes, and it must work regardless
 * of what the main window happens to be showing. (The SPA's Settings popover has
 * its own, *user-initiated* path — see `checkForUpdatesNow`.)
 *
 * Three outcomes:
 *  - **restart** → apply now.
 *  - **later** → remembered per version FOR THIS RUN only. Re-prompting on every
 *    check would nag someone who already said no; forgetting across launches would
 *    mean a deferred update is never mentioned again. Prompting once per launch is
 *    the middle that needs no state on disk — and an explicit "check for updates"
 *    clears it, because asking IS undeclining.
 *  - **skip** → remembered ACROSS launches (persisted): the user doesn't want this
 *    version at all. A newer one is still offered; "check for updates" clears skips.
 */
async function offerUpdate(info: UpdateInfo, deps: UpdaterDeps): Promise<void> {
  const { version } = info;
  // Skipped versions are never re-offered — checked first, before the per-run
  // guards, so a skip persisted last launch is honored on this one too.
  const prefs = await loadUpdatePrefs(updatePrefsFile());
  if (prefs.skippedVersions.includes(version)) {
    log(`skipping ${version} (user chose Skip this version)`);
    return;
  }
  if (declined.has(version) || promptOpen) return;
  if (deps.mainWindow.isDestroyed()) return;

  promptOpen = true;
  // Held across the apply, not just the window: shutdown takes seconds, and
  // releasing early let a second `update-downloaded` stack another prompt on top
  // of an app that was already installing.
  try {
    const choice = await showUpdatePrompt(deps.mainWindow, {
      version,
      autoUpdate: prefs.autoUpdate,
      onAutoUpdateChange: setAutoUpdatePref,
    });

    if (choice === "skip") {
      await addSkippedVersion(version, updatePrefsFile());
      log(`user skipped ${version}`);
      // Honor the skip even under auto-install: a staged update would otherwise
      // install on the next quit. Drop it and stop that for this session — the
      // pref itself is untouched, so next launch restores it and a manual check
      // (which clears skips) re-offers.
      if (pending?.version === version) {
        pending = null;
        if (active) active.autoUpdater.autoInstallOnAppQuit = false;
      }
      // A skip also retracts the rail's "Update now" card — it mirrors
      // `pending`, and "skip this version" means exactly "stop showing me
      // ways back to it".
      pushUpdateState();
      return;
    }
    if (choice !== "restart") {
      declined.add(version);
      log(`user deferred ${version}`);
      return;
    }

    const result = await applyUpdate(version);
    if (!result.ok) {
      // Never silently: the user pressed "Restart now" and nothing happened, so
      // say what and why. Their sessions are still alive in the refuse-up-front
      // case, which is exactly what the message needs to tell them. The rare
      // failure stays a native dialog — an OK-only acknowledgement.
      pending = null;
      // The SPA's card mirrors `pending` — retract it, or it wedges on a
      // "ready to install" that can never install.
      pushUpdateState();
      await dialog.showMessageBox(deps.mainWindow, {
        type: "warning",
        buttons: ["OK"],
        message: `Sapiom ${version} could not be installed.`,
        detail: result.reason ?? "The update could not be applied.",
      });
    }
  } finally {
    promptOpen = false;
  }
}

/**
 * Check right now, on the user's behalf, and describe what happened.
 *
 * This is the Settings popover's "Check for updates" button. It differs from the
 * scheduled check in three ways, and each one is a thing users notice:
 *  - it REPORTS an outcome. A silent background check is fine; a button that
 *    appears to do nothing is broken.
 *  - it clears the declined set AND the persisted skip list, so someone who chose
 *    "Later" or "Skip this version" can change their mind without restarting.
 *  - it answers "downloaded" for an update already waiting, rather than the
 *    literally-true-but-useless "you're up to date".
 *
 * Never throws: every failure becomes a `failed` outcome the UI can render.
 */
export async function checkForUpdatesNow(): Promise<UpdateCheckOutcome> {
  if (!active) {
    return { kind: "disabled", reason: disabledReason ?? "updates are not available in this build" };
  }
  // Asking is undeclining — and it has to happen BEFORE the `pending` shortcut
  // below, or it never happens in the one case that matters: choosing "Later"
  // sets `pending`, so returning early would leave the version declined for the
  // rest of the run and the update prompt would never come back.
  declined.clear();
  // ...and un-skip: an explicit ask is the user reconsidering, so a version they
  // chose "Skip this version" for is offered again too.
  await clearSkippedVersions(updatePrefsFile());
  // Something already downloaded and waiting to be applied: report that instead of
  // asking GitHub again, and RE-RAISE the update window. That window is the only
  // way to actually apply an update — the SPA has no restart channel, by design —
  // and it already carries the wording that matters ("this ends running agent
  // sessions"). Re-offering here is what `declined.clear()` above exists for: a
  // user who chose "Later" and then asked again gets asked again.
  if (pending) {
    const info = pending;
    if (host) {
      void offerUpdate(info, host).catch((err: unknown) => {
        log(`re-offer failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return { kind: "downloaded", version: info.version };
  }
  // Replay a very recent SUCCESSFUL answer instead of asking again. One check
  // costs ~3 unauthenticated GitHub requests, and nothing else in this module
  // is unbounded — but serial clicks were, limited only by how fast a human
  // can click, which is how an IP earns a 429. A failed check is never
  // replayed: retrying after a failure is precisely what the button is for,
  // and the window is short enough that "nothing happened" is not a thing a
  // user can perceive (the same answer still toasts).
  const now = Date.now();
  if (lastGoodCheck && now - lastGoodCheck.at < CHECK_REPLAY_WINDOW_MS) {
    return lastGoodCheck.outcome;
  }
  // Coalesce concurrent asks rather than firing two requests at GitHub.
  checkInFlight ??= runCheck(active);
  try {
    const outcome = await checkInFlight;
    if (outcome.kind === "up-to-date" || outcome.kind === "available") {
      lastGoodCheck = { at: Date.now(), outcome };
    }
    return outcome;
  } finally {
    checkInFlight = null;
  }
}

/** See `checkForUpdatesNow`: how long a successful answer stands in for a new ask. */
const CHECK_REPLAY_WINDOW_MS = 60_000;
/** The last check that actually reached GitHub and got an answer. */
let lastGoodCheck: { at: number; outcome: UpdateCheckOutcome } | null = null;

/** One quick second chance for a dropped connection — see runCheck's catch. */
const CHECK_RETRY_DELAY_MS = 2_000;

async function runCheck(
  current: NonNullable<typeof active>,
  attempt = 1,
): Promise<UpdateCheckOutcome> {
  try {
    const result = await current.autoUpdater.checkForUpdates();
    if (!result) {
      // electron-updater returns null when it declines to check at all (no
      // update config, or a check already running). Not an error, but not an
      // answer either — don't dress it up as "up to date".
      return { kind: "failed", message: "The update check did not run." };
    }
    if (result.isUpdateAvailable) {
      log(`on-demand check: ${result.updateInfo.version} available`);
      return { kind: "available", version: result.updateInfo.version };
    }
    return { kind: "up-to-date", version: app.getVersion(), channel: current.channel };
  } catch (err) {
    // NEVER forward the raw message: for a channel with no published release,
    // electron-updater appends the whole releases Atom feed and a stack trace, so
    // it is kilobytes of XML — which went straight into a toast once.
    const { kind, summary } = classifyUpdateError(err instanceof Error ? err.message : String(err));
    // A network-class failure gets ONE quick retry before it reaches the user:
    // the first outbound connection of a fresh process is the one AV/proxies/
    // cold TLS eat (measured: an ERR_EMPTY_RESPONSE first check whose immediate
    // successor succeeded — the user saw "could not reach GitHub" for a
    // connection drop the very next attempt absorbed).
    if (kind === "offline" && attempt === 1) {
      log(`check failed (${kind}): ${summary} — retrying once in ${CHECK_RETRY_DELAY_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, CHECK_RETRY_DELAY_MS));
      return runCheck(current, attempt + 1);
    }
    log(`on-demand check failed (${kind}): ${summary}`);
    if (kind === "no-release") return { kind: "no-release", channel: current.channel };
    return { kind: "failed", message: summary };
  }
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
  host = deps;
  // Registered BEFORE (and regardless of) the gate. The SPA's button is wired to
  // these channels, and `ipcRenderer.invoke` on a channel with no handler REJECTS
  // — so skipping registration for a build with updates disabled would turn a
  // clear "updates are off in this build" into an opaque renderer-side error.
  registerHandlers();
  // Also regardless of the gate: a reload wipes renderer state but not
  // `pending`, so every finished load re-learns the current update state (an
  // honest `none` when updates are off — the card simply never appears).
  deps.mainWindow.webContents.on("did-finish-load", pushUpdateState);
  try {
    startUpdater(deps);
  } catch (err) {
    disabledReason = `initialisation failed: ${err instanceof Error ? err.message : String(err)}`;
    log(`could not initialise: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Idempotent: `ipcMain.handle` throws if a channel is registered twice. */
let handlersRegistered = false;
function registerHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  ipcMain.handle(UPDATE_CHECK, async (event): Promise<UpdateCheckOutcome> => {
    // Answer, rather than throw, so an unexpected caller gets a dead end instead
    // of a stack trace to probe.
    if (!isTrustedSender(event)) return { kind: "disabled", reason: "not available here" };
    return checkForUpdatesNow();
  });
}

/**
 * Structural one-shot guard, not a convention.
 *
 * `startUpdater` arms a boot timeout AND a 4h interval, and nothing clears
 * them. A second call would therefore double the check rate permanently —
 * the classic way a polite cadence turns into a request storm — while
 * `handlersRegistered` above silently masked the double-init. Unreachable
 * today (one `app.whenReady`, single-instance lock), so this exists to keep
 * it unreachable when a future caller appears.
 */
let updaterStarted = false;

function startUpdater(deps: UpdaterDeps): void {
  if (updaterStarted) {
    log("startUpdater called twice — ignoring the second (timers are already armed)");
    return;
  }
  const gate = shouldEnableUpdater({
    isPackaged: app.isPackaged,
    devMode: deps.devMode,
    smoke: deps.smoke,
    env: process.env,
  });
  if (!gate.enabled) {
    disabledReason = gate.reason ?? "updates are disabled";
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
  // Whether an ordinary quit installs a downloaded update is now USER-controlled,
  // via the update window's "Automatically download and install updates" toggle
  // (persisted in update-prefs). Default ON: a ready update installs on the next
  // quit — never a surprise mid-session restart, since the running app is only ever
  // restarted by an explicit "Restart now". This reverses the former hardcoded
  // `false` ("the behaviour we deliberately declined"), now that the user owns it.
  // Set the default synchronously (loading prefs is async and the first check is
  // 30s out), then reconcile with the persisted value; a failed read keeps the
  // default — prefs are a convenience, never load-bearing.
  autoUpdater.autoInstallOnAppQuit = DEFAULT_UPDATE_PREFS.autoUpdate;
  void loadUpdatePrefs(updatePrefsFile())
    .then((prefs) => {
      autoUpdater.autoInstallOnAppQuit = prefs.autoUpdate;
      // Re-resolve the channel now that the persisted opt-in is known. Same
      // async-after-sync shape as the toggle above and safe for the same reason:
      // the first check is FIRST_CHECK_DELAY_MS (30s) out, and this read takes
      // milliseconds. Re-assigning `channel` with a string is fine — the setter
      // only rejects a non-string once a channel has been set — though note it
      // also flips `allowDowngrade` to true, which is what we want for a machine
      // moving onto betas.
      const withPrefs = resolveUpdateChannel(app.getVersion(), process.env, prefs);
      if (withPrefs.channel !== decision.channel) {
        autoUpdater.channel = withPrefs.channel;
        autoUpdater.allowPrerelease = withPrefs.allowPrerelease;
        active = active ? { ...active, channel: withPrefs.channel } : active;
        log(`channel → "${withPrefs.channel}" (pre-release opt-in ${prefs.preRelease ? "on" : "off"})`);
      }
    })
    .catch(() => {
      /* keep the defaults — prefs are a convenience, never load-bearing */
    });
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
    // Recorded before we prompt: whatever the user answers, this version is now
    // on disk and applying it is a restart away — which is what the SPA's button
    // needs to know to say "restart" instead of "up to date".
    pending = info;
    void (async () => {
      // A persisted skip is honored BEFORE anything becomes visible: no rail
      // card, no prompt (offerUpdate re-checks, but by then the card would
      // already be up), and no silent install of the very version the user
      // refused — with the staged artifact left as `pending` under an ON
      // auto-install toggle, the next ordinary quit would apply it.
      const prefs = await loadUpdatePrefs(updatePrefsFile());
      if (prefs.skippedVersions.includes(info.version)) {
        log(`skipping ${info.version} (user chose Skip this version)`);
        if (pending?.version === info.version) pending = null;
        autoUpdater.autoInstallOnAppQuit = false;
        pushUpdateState();
        return;
      }
      // The rail's "Update now" card appears now and OUTLIVES the prompt
      // below: a user who chooses "Later" keeps a visible way back to the
      // restart.
      pushUpdateState();
      await offerUpdate(info, deps);
    })().catch((err: unknown) => {
      log(`failed to offer ${info.version}: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  autoUpdater.on("error", (err) => {
    // Expected in the field, and never fatal: no network, a release without
    // metadata, an AppImage the user extracted, a .deb with no working package
    // manager. The app keeps working on the version it has.
    log(`check failed: ${classifyUpdateError(err.message).summary}`);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      // checkForUpdates rejects AND emits "error"; swallow here so the
      // rejection can't surface as an unhandled promise.
      log(`check rejected: ${classifyUpdateError(err instanceof Error ? err.message : String(err)).summary}`);
    });
  };

  log(
    `enabled — channel "${decision.channel}", allowPrerelease=${decision.allowPrerelease}` +
      `${gate.forced ? ", forced (dev config)" : ""}`,
  );
  // Last: publishing `active` is what enables the on-demand path, so it happens
  // only once everything above has been configured without throwing.
  active = { autoUpdater, channel: decision.channel, deps };
  disabledReason = null;
  // Set with the timers, so the guard covers exactly the thing that must not
  // happen twice (an enabled build arming a second interval). A gated-off
  // build returns above without marking, and stays free to be re-inited.
  updaterStarted = true;
  // .unref() so a pending check can't hold the process alive during quit.
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}
