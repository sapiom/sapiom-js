/**
 * Native boot sequence — the Electron mirror of the harness CLI's `bin.ts`
 * (`doctor → auth → consent → startServer → open`). Instead of a browser tab,
 * it loads the harness SPA in a native BrowserWindow. Reuses the harness's own
 * `startServer`/`runDoctor`/`ensureAuthenticated`/settings via the re-export
 * surface added in `@sapiom/harness` — the npx CLI stays the untouched backup.
 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runDoctor,
  pickDefaultHarness,
  ensureAuthenticated,
  ensureSpawnHelperExecutable,
  getOrCreateMachineId,
  loadSettings,
  recordRecentDir,
  startServer,
  CLAUDE_INSTALL_COMMAND,
  CODEX_INSTALL_COMMAND,
  type HarnessServer,
  type HarnessIdentity,
} from "@sapiom/harness";
import { augmentProcessPath } from "./env.js";
import { resolveWebDir } from "./paths.js";
import { createMainWindow } from "./windows.js";
import { BOOT_PROGRESS, BOOT_ERROR, CONSENT_SUBMIT, type BootProgress, type BootErrorPayload } from "./ipc.js";

export interface BootResult {
  server: HarnessServer;
  mainWindow: BrowserWindow;
  /** The tokened local URL the main window loaded (useful for dev smoke tests). */
  url: string;
}

function progress(setupWin: BrowserWindow, p: BootProgress): void {
  if (!setupWin.isDestroyed()) setupWin.webContents.send(BOOT_PROGRESS, p);
}
function bootError(setupWin: BrowserWindow, e: BootErrorPayload): void {
  if (!setupWin.isDestroyed()) setupWin.webContents.send(BOOT_ERROR, e);
}

/** The bin dir where the app-managed npm --prefix install lands the agent (Phase 3). */
function agentBinDir(): string {
  const prefix = path.join(app.getPath("userData"), "npm-global");
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

/** Baked default environment; a shell-set SAPIOM_ENVIRONMENT wins (for devs). */
function resolveTargetEnvironment(): string {
  if (process.env.SAPIOM_ENVIRONMENT) return process.env.SAPIOM_ENVIRONMENT;
  // Release builds bake "production"; dev builds default to production too
  // unless a dev points SAPIOM_ENVIRONMENT at local/staging.
  const baked = process.env.SAPIOM_ENV /* build-time */ ?? "production";
  process.env.SAPIOM_ENVIRONMENT = baked;
  return baked;
}

async function decideConsent(
  setupWin: BrowserWindow,
  devMode: boolean,
  firstRun: boolean,
): Promise<{ telemetryOptIn: boolean; consentSource: "env-forced-off" | "stored-explicit" | "prompted" | "default-silent" }> {
  const envOff = ["1", "true"].includes((process.env.SAPIOM_TELEMETRY_DISABLED ?? "").toLowerCase()) ||
    ["1", "true"].includes((process.env.DO_NOT_TRACK ?? "").toLowerCase());
  if (envOff) return { telemetryOptIn: false, consentSource: "env-forced-off" };

  if (devMode || !firstRun) {
    const settings = await loadSettings();
    const stored = (settings as { telemetryOptIn?: boolean }).telemetryOptIn;
    if (typeof stored === "boolean") return { telemetryOptIn: stored, consentSource: "stored-explicit" };
    return { telemetryOptIn: false, consentSource: "default-silent" };
  }

  // First run, interactive: ask in the setup window and wait for the answer.
  progress(setupWin, { phase: "consent", message: "Share anonymous usage data?", status: "active" });
  const optIn = await new Promise<boolean>((resolve) => {
    ipcMain.handleOnce(CONSENT_SUBMIT, (_e, value: boolean) => {
      resolve(Boolean(value));
    });
  });
  return { telemetryOptIn: optIn, consentSource: "prompted" };
}

function isDir(p: string | undefined): p is string {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory the coding agent opens in. NEVER the app's own cwd (that would
 * open the agent inside the install dir). Precedence:
 *   1. SAPIOM_LAUNCH_DIR env (explicit dev/testing override)
 *   2. native folder picker on first run / when no valid recent dir (real flow)
 *   3. most recent *valid* project dir
 *   4. the user's home directory
 */
async function chooseLaunchDir(devMode: boolean, firstRun: boolean): Promise<string> {
  const override = process.env.SAPIOM_LAUNCH_DIR;
  if (isDir(override)) return override;

  const settings = await loadSettings();
  const lastValid = settings.recentDirs?.find(isDir);

  // Dev: never block on a native dialog and never fall back to the app cwd.
  if (devMode) return lastValid ?? os.homedir();

  if (firstRun || !lastValid) {
    const result = await dialog.showOpenDialog({
      title: "Choose a project folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: lastValid ?? os.homedir(),
    });
    if (!result.canceled && result.filePaths[0]) return result.filePaths[0];
    return lastValid ?? os.homedir();
  }
  return lastValid;
}

export async function boot(setupWin: BrowserWindow, devMode: boolean): Promise<BootResult> {
  progress(setupWin, { phase: "starting", message: "Starting Sapiom…", status: "active" });

  // 1. PATH — must precede doctor so `which claude` works in a GUI app.
  augmentProcessPath(agentBinDir());
  resolveTargetEnvironment();

  // 2. Doctor.
  progress(setupWin, { phase: "doctor", message: "Checking your environment…", status: "active" });
  let report = await runDoctor();

  // 3. Agent presence. Phase 3 replaces this block with an auto-install; for
  //    now, if no agent is found, surface a guided-install error (retryable).
  if (report.availableHarnesses.length === 0) {
    bootError(setupWin, {
      message: "No coding agent found.",
      detail:
        `Install one, then click Retry:\n  Claude Code:  ${CLAUDE_INSTALL_COMMAND}\n  Codex:        ${CODEX_INSTALL_COMMAND}`,
      retryable: true,
    });
    // Re-run doctor when the user retries.
    await new Promise<void>((resolve) => ipcMain.handleOnce("boot:retry", () => resolve()));
    report = await runDoctor();
    if (report.availableHarnesses.length === 0) throw new Error("No coding agent available after retry.");
  }
  progress(setupWin, { phase: "doctor", message: `Found: ${report.availableHarnesses.join(", ")}`, status: "done" });

  // 4. Machine id + first-run (read BEFORE recordRecentDir, like bin.ts).
  const machineId = await getOrCreateMachineId();
  const firstRun = (await loadSettings()).recentDirs.length === 0;

  // 5. Auth (cached credential returns immediately; fresh opens the browser).
  progress(setupWin, { phase: "auth", message: "Signing you in…", status: "active" });
  const identity: HarnessIdentity | null = await ensureAuthenticated({ interactive: true });
  progress(setupWin, {
    phase: "auth",
    message: identity ? `Signed in: ${identity.organizationName}` : "Continuing without sign-in",
    status: "done",
  });

  // 6. Consent (native, not TTY).
  const { telemetryOptIn, consentSource } = await decideConsent(setupWin, devMode, firstRun);

  // 7. Project folder.
  progress(setupWin, { phase: "choosing-folder", message: "Choosing your project folder…", status: "active" });
  const launchDir = await chooseLaunchDir(devMode, firstRun);
  await recordRecentDir(launchDir);

  // 8. Boot the harness server.
  progress(setupWin, { phase: "launching", message: "Launching…", status: "active" });
  await ensureSpawnHelperExecutable().catch(() => {
    /* best-effort pre-warm; PTY spawn will surface a real failure later */
  });
  const bootToken = randomBytes(32).toString("hex");
  const server = await startServer({
    port: 0,
    host: "127.0.0.1",
    bootToken,
    telemetryOptIn,
    consentSource,
    identity: identity ?? undefined,
    machineId,
    webDir: resolveWebDir(),
    launchDir,
    autoCreateSession: !firstRun,
    defaultHarnessKind: pickDefaultHarness(report),
    availableHarnesses: report.availableHarnesses,
    firstRun,
  });

  // 9. Load the SPA in the main window; close setup once it renders.
  const url = `http://127.0.0.1:${server.port}/?token=${bootToken}`;
  const mainWindow = createMainWindow(url);
  mainWindow.webContents.once("did-finish-load", () => {
    if (!setupWin.isDestroyed()) setupWin.close();
  });
  progress(setupWin, { phase: "ready", message: "Ready.", status: "done" });

  return { server, mainWindow, url };
}
