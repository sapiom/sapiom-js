/**
 * Native boot sequence — the Electron mirror of the harness CLI's `bin.ts`
 * (`doctor → auth → consent → startServer → open`). Instead of a browser tab,
 * it loads the harness SPA in a native BrowserWindow. Reuses the harness's own
 * `startServer`/`runDoctor`/`ensureAuthenticated`/settings via the re-export
 * surface added in `@sapiom/harness` — the npx CLI stays the untouched backup.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
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
  type DoctorReport,
} from "@sapiom/harness";
import { augmentProcessPath } from "./env.js";
import { resolveWebDir } from "./paths.js";
import { createMainWindow } from "./windows.js";
import { installClaudeCode } from "./agent-install.js";
import { installRuntimeShims } from "./runtime-shims.js";
import { BOOT_PROGRESS, BOOT_ERROR, CONSENT_SUBMIT, RETRY, type BootProgress, type BootErrorPayload } from "./ipc.js";

export interface BootResult {
  server: HarnessServer;
  mainWindow: BrowserWindow;
  /** The tokened local URL the main window loaded (useful for dev smoke tests). */
  url: string;
}

/** Gated boot tracing (`SAPIOM_BOOT_DEBUG=1`) — prints each step to stderr so a
 *  stuck onboarding can be pinpointed without a visible setup window. */
function debug(msg: string): void {
  if (process.env.SAPIOM_BOOT_DEBUG === "1") console.error(`[boot] ${msg}`);
}

function progress(setupWin: BrowserWindow, p: BootProgress): void {
  debug(`progress ${p.phase}/${p.status}: ${p.message}`);
  if (!setupWin.isDestroyed()) setupWin.webContents.send(BOOT_PROGRESS, p);
}
function bootError(setupWin: BrowserWindow, e: BootErrorPayload): void {
  if (!setupWin.isDestroyed()) setupWin.webContents.send(BOOT_ERROR, e);
}

/**
 * Resolve a concrete free localhost port. We must NOT use startServer's
 * `port: 0` (ephemeral): the harness builds the agent's SAPIOM_HARNESS_INGEST_URL
 * from the *requested* port at construction time (before the socket binds), so
 * `port: 0` yields `http://127.0.0.1:0/ingest` — the SessionStart hook then
 * POSTs to port 0, never reaches the harness, and the session never becomes
 * "ready" (blocking Use-skill / image inject). A concrete port avoids that.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
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
 * `~/.sapiom/harness` — mirrors the harness's HARNESS_HOME (its state root and
 * where the sample project is seeded). Used as the default project root so the
 * seeded sample shows up in the workflows rail, and so a non-technical user is
 * never asked to pick a folder.
 */
function defaultProjectRoot(): string {
  return path.join(os.homedir(), ".sapiom", "harness");
}

/**
 * The directory the coding agent opens in. NEVER the app's own cwd (that would
 * open the agent inside the install dir), and NEVER an OS folder picker — a
 * one-click user shouldn't have to choose a path. Precedence:
 *   1. SAPIOM_LAUNCH_DIR env (explicit dev/testing override)
 *   2. most recent *valid* project dir (returning users)
 *   3. the default project root under ~/.sapiom (first launch / new project)
 */
async function chooseLaunchDir(): Promise<string> {
  const override = process.env.SAPIOM_LAUNCH_DIR;
  if (isDir(override)) return override;

  const settings = await loadSettings();
  const lastValid = settings.recentDirs?.find(isDir);
  if (lastValid) return lastValid;

  const dir = defaultProjectRoot();
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Guarantee at least one coding agent is available, starting from a doctor
 * report that found none. First attempts an automatic install of the default
 * agent (Claude Code) into the per-user npm prefix; if doctor still finds
 * nothing afterwards, drops to a retryable guided-install screen and loops
 * until the user installs one manually (or closes the window).
 */
async function ensureAgentAvailable(setupWin: BrowserWindow, initialReport: DoctorReport): Promise<DoctorReport> {
  let report = initialReport;

  // Attempt 1: automatic install (streams npm's output to the setup window).
  progress(setupWin, { phase: "installing-agent", message: "Installing Claude Code…", status: "active" });
  let autoInstallSucceeded = false;
  try {
    const result = await installClaudeCode((line) => {
      progress(setupWin, { phase: "installing-agent", message: line, status: "active" });
    });
    autoInstallSucceeded = result.ok;
    if (!result.ok) {
      // Non-fatal: fall through to re-doctor (a PATH-resolvable agent may still
      // exist) and, failing that, the guided fallback below.
      progress(setupWin, {
        phase: "installing-agent",
        message: `Automatic setup didn't complete (npm exit ${result.code ?? "?"}).`,
        status: "error",
      });
    }
  } catch (err) {
    progress(setupWin, {
      phase: "installing-agent",
      message: err instanceof Error ? err.message : String(err),
      status: "error",
    });
  }

  report = await runDoctor();

  // Guided fallback: loop on user retries until an agent appears on PATH.
  while (report.availableHarnesses.length === 0) {
    bootError(setupWin, {
      message: autoInstallSucceeded
        ? "Installed your coding agent, but it wasn't detected."
        : "Couldn't set up your coding agent automatically.",
      detail:
        `Install one manually, then click Retry:\n` +
        `  Claude Code:  ${CLAUDE_INSTALL_COMMAND}\n` +
        `  Codex:        ${CODEX_INSTALL_COMMAND}\n\n` +
        `(Requires Node.js — https://nodejs.org)`,
      retryable: true,
    });
    await new Promise<void>((resolve) => ipcMain.handleOnce(RETRY, () => resolve()));
    progress(setupWin, { phase: "doctor", message: "Re-checking…", status: "active" });
    report = await runDoctor();
  }
  return report;
}

export async function boot(setupWin: BrowserWindow, devMode: boolean): Promise<BootResult> {
  progress(setupWin, { phase: "starting", message: "Starting Sapiom…", status: "active" });

  // 1. PATH — must precede doctor so `which claude` works in a GUI app. Also
  //    materialize node/npm shims (Electron-as-Node) and put them first, so the
  //    embedded harness can `npm install` the seeded project (and run project
  //    tooling) with no system Node/npm.
  const runtimeShimDir = installRuntimeShims();
  augmentProcessPath(agentBinDir(), runtimeShimDir);
  resolveTargetEnvironment();

  // 2. Doctor.
  progress(setupWin, { phase: "doctor", message: "Checking your environment…", status: "active" });
  let report = await runDoctor();

  // 3. Agent presence. If no coding agent is on PATH, auto-install the default
  //    (Claude Code) behind a "Setting up…" screen, then re-run doctor; on
  //    failure, fall back to a retryable guided-install screen. Dev-only
  //    SAPIOM_FORCE_NO_AGENT=1 forces this branch to exercise auto-install.
  const forceNoAgent = devMode && process.env.SAPIOM_FORCE_NO_AGENT === "1";
  if (forceNoAgent || report.availableHarnesses.length === 0) {
    report = await ensureAgentAvailable(setupWin, report);
  }
  progress(setupWin, { phase: "doctor", message: `Found: ${report.availableHarnesses.join(", ")}`, status: "done" });

  // 4. Machine id + first-run (read BEFORE recordRecentDir, like bin.ts).
  const machineId = await getOrCreateMachineId();
  const firstRun = (await loadSettings()).recentDirs.length === 0;

  // 5. Auth. Probe for a cached credential first (non-interactive) so we can
  //    show the right message: a cached credential signs in instantly; without
  //    one we must open the browser and tell the user to complete sign-in there
  //    (otherwise the window just sits on a vague "Signing you in…").
  progress(setupWin, { phase: "auth", message: "Signing you in…", status: "active" });
  let identity: HarnessIdentity | null = await ensureAuthenticated({ interactive: false });
  if (!identity) {
    progress(setupWin, {
      phase: "auth",
      message: "Opening your browser — sign in to Sapiom to continue, then come back here.",
      status: "active",
    });
    identity = await ensureAuthenticated({ interactive: true });
  }
  progress(setupWin, {
    phase: "auth",
    message: identity ? `Signed in: ${identity.organizationName}` : "Continuing without sign-in",
    status: "done",
  });

  // 6. Consent (native, not TTY).
  const { telemetryOptIn, consentSource } = await decideConsent(setupWin, devMode, firstRun);

  // 7. Project folder (defaulted under ~/.sapiom — no picker).
  progress(setupWin, { phase: "choosing-folder", message: "Preparing your workspace…", status: "active" });
  const launchDir = await chooseLaunchDir();
  await recordRecentDir(launchDir);

  // 8. Boot the harness server.
  progress(setupWin, { phase: "launching", message: "Launching…", status: "active" });
  await ensureSpawnHelperExecutable().catch(() => {
    /* best-effort pre-warm; PTY spawn will surface a real failure later */
  });
  const bootToken = randomBytes(32).toString("hex");
  const port = await findFreePort();
  const server = await startServer({
    port,
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
