/**
 * Native boot sequence — the Electron mirror of the harness CLI's `bin.ts`
 * (`doctor → auth → consent → startServer → open`). Instead of a browser tab,
 * it loads the harness SPA in a native BrowserWindow. Reuses the harness's own
 * `startServer`/`runDoctor`/`ensureAuthenticated`/settings via the re-export
 * surface added in `@sapiom/harness` — the npx CLI stays the untouched backup.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  runDoctor,
  pickDefaultHarness,
  ensureAuthenticated,
  ensureSpawnHelperExecutable,
  getOrCreateMachineId,
  loadSettings,
  saveSettings,
  recordRecentDir,
  hasStoredSettings,
  startServer,
  createClaudeCodeAdapter,
  createCodexAdapter,
  resolveSpawnTarget,
  CLAUDE_INSTALL_COMMAND,
  CODEX_INSTALL_COMMAND,
  type HarnessServer,
  type HarnessIdentity,
  type DoctorReport,
} from "@sapiom/harness";
import { resolveLaunchDir } from "./launch-dir.js";
import { augmentProcessPath } from "./env.js";
import { esbuildBinaryPath } from "./esbuild-binary.js";
import { resolveWebDir } from "./paths.js";
import { createMainWindow } from "./windows.js";
import { agentPrefixDir, ensureSapiomCli, installAgentVersion, installClaudeCode, installSapiomMcp } from "./agent-install.js";
import { ensureAgentUpdates } from "./agent-updates.js";
import { runUpdateCommand } from "./agent-update-process.js";
import { agentRepairDecision } from "./agent-repair.js";
import { ensureMinGit } from "./git-provision.js";
import { ensureSapiomMcp } from "./mcp-install.js";
import { installRuntimeShims } from "./runtime-shims.js";
import {
  BOOT_PROGRESS,
  BOOT_ERROR,
  CONSENT_SUBMIT,
  RETRY,
  type BootProgress,
  type BootErrorPayload,
  type DeepLinkTarget,
} from "./ipc.js";

export interface BootResult {
  server: HarnessServer;
  mainWindow: BrowserWindow;
  /** Trusted-main-process copy used only by packaged smoke checks. */
  bootToken: string;
  /** The UI-credentialed local URL the main window loaded. */
  url: string;
}

/** Gated boot tracing (`SAPIOM_BOOT_DEBUG=1`) — prints each step to stderr so a
 *  stuck onboarding can be pinpointed without a visible setup window. */
function debug(msg: string): void {
  if (process.env.SAPIOM_BOOT_DEBUG === "1") console.error(`[boot] ${msg}`);
}

/**
 * Is a system git on PATH? Shells `where` — the same probe the doctor uses
 * (`harness/src/cli/doctor.ts`) — rather than resolveSpawnTarget, which on
 * non-Windows is a filesystem-blind passthrough. Windows-only caller today,
 * but keep the POSIX arm so the helper stays honest if that changes.
 */
async function hasSystemGit(): Promise<boolean> {
  const exec = promisify(execFile);
  try {
    await exec(process.platform === "win32" ? "where" : "which", ["git"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
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
  /** Modes that cannot prompt a human: `--dev` and `--smoke`. */
  skipPrompt: boolean,
  firstRun: boolean,
): Promise<{ telemetryOptIn: boolean; consentSource: "env-forced-off" | "stored-explicit" | "prompted" | "default-silent" }> {
  const envOff = ["1", "true"].includes((process.env.SAPIOM_TELEMETRY_DISABLED ?? "").toLowerCase()) ||
    ["1", "true"].includes((process.env.DO_NOT_TRACK ?? "").toLowerCase());
  if (envOff) return { telemetryOptIn: false, consentSource: "env-forced-off" };

  if (skipPrompt || !firstRun) {
    const { telemetryOptIn } = await loadSettings();
    // `!firstRun` means a settings file exists, so its value is what the user
    // answered. When we skip the prompt on a genuine first run (dev/smoke), the
    // value is loadSettings' default, not an answer, and the SPA needs
    // "default-silent" to know it may still show its first-run consent notice.
    return { telemetryOptIn, consentSource: firstRun ? "default-silent" : "stored-explicit" };
  }

  // First run, interactive: ask in the setup window and wait for the answer.
  // No subtitle: the checkbox below IS the question, so a "Share anonymous usage
  // data?" detail line just duplicates it. "One quick question…" + the checkbox
  // is the whole ask.
  progress(setupWin, { phase: "consent", message: "", status: "active" });
  const optIn = await new Promise<boolean>((resolve) => {
    ipcMain.handleOnce(CONSENT_SUBMIT, (_e, value: boolean) => {
      resolve(Boolean(value));
    });
  });
  // Persist it, exactly as the CLI's `ensureConsent` does after its Y/n prompt.
  // Without this the answer only ever lived in memory: `startServer` got the
  // right value (so telemetry really was on this run), but the settings file —
  // which is what GET /api/state and GET /api/settings read for the SPA's
  // "analytics on/off" chip, AND what the next launch resolves consent from —
  // still said false. So an opt-in showed as "analytics off" in the UI and was
  // silently lost on the next launch. Written before `recordRecentDir` below,
  // whose read-modify-write then carries it through.
  const settings = await loadSettings();
  await saveSettings({ ...settings, telemetryOptIn: optIn });
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
 * one-click user shouldn't have to choose a path.
 *
 * Always the harness home (unless `SAPIOM_LAUNCH_DIR` overrides it): the launch
 * dir is the stable scan root that `projectRoot = <launchDir>/projects` is
 * derived from, so it must not drift into a project subfolder. See
 * `resolveLaunchDir` for why deriving it from `recentDirs` nested every new
 * agent one level deeper.
 */
async function chooseLaunchDir(): Promise<string> {
  const dir = resolveLaunchDir({
    override: process.env.SAPIOM_LAUNCH_DIR,
    harnessHome: defaultProjectRoot(),
    isDir,
  });
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

export interface BootMode {
  /** Cancel startup when the user quits from the setup window. */
  signal?: AbortSignal;
  /** `--dev`: skips the consent prompt and logs the ready URL. */
  devMode: boolean;
  /**
   * `--smoke`: unattended verification of a *packaged* build (see smoke.ts).
   * Nothing may block on a human or the network, so this mode never prompts
   * for consent, never opens a browser for sign-in, and never auto-installs an
   * agent — it boots as far as it can and lets the checks report. It is NOT a
   * user-facing mode: no flow is skipped that a real launch would need, so a
   * smoke pass still exercises PATH, asar paths, the server, and the windows.
   */
  smoke: boolean;
  /**
   * A `sapiom://` deep link present at COLD start (a macOS `open-url` that
   * arrived before `whenReady`, or the URL in Windows/Linux argv). Its target is
   * threaded onto the SPA load URL as `?agent=<id>` so the first render already
   * has it — no IPC race. Links that arrive while the app is running are pushed
   * over the DEEP_LINK_NAVIGATE channel instead (see index.ts).
   */
  deepLink?: DeepLinkTarget;
}

export async function boot(setupWin: BrowserWindow, mode: BootMode): Promise<BootResult> {
  const { devMode, smoke } = mode;
  progress(setupWin, { phase: "starting", message: "Starting…", status: "active" });

  // 1. PATH — must precede doctor so `which claude` works in a GUI app. Also
  //    materialize node/npm shims (Electron-as-Node) and put them first, so the
  //    embedded harness can `npm install` the seeded project (and run project
  //    tooling) with no system Node/npm.
  const runtimeShimDir = installRuntimeShims();
  augmentProcessPath(agentBinDir(), runtimeShimDir);
  resolveTargetEnvironment();

  // 1b. esbuild's native binary was pinned by index.ts's first import — far
  //     earlier than here, because esbuild reads the setting when its module
  //     loads (esbuild-binary.ts). Only traced here, where the boot log is.
  debug(`esbuild binary: ${esbuildBinaryPath ?? "left to esbuild's own resolution"}`);

  // 1c. Git, on Windows machines that have none. Template cloning and deploy
  //     shell out to a real git (agent-core's cloneRepo/pushSynthesizedTree),
  //     and Windows ships without one — the same reasoning as the node/npm
  //     shims and the agent auto-install: the one-click user must not be sent
  //     to git-scm.com. Downloads the checksum-pinned official MinGit into
  //     userData on first boot (see git-provision.ts); non-fatal, and never in
  //     smoke (no network in CI). A user-installed git always wins: this
  //     branch is skipped whenever `where git` resolves, and the provisioned
  //     dir is APPENDED to PATH. When the MinGit variant carries a bash.exe,
  //     advertise it via CLAUDE_CODE_GIT_BASH_PATH — Claude Code prefers Git
  //     Bash for its shell/hooks on Windows and falls back to PowerShell
  //     without it.
  if (!smoke && process.platform === "win32" && !(await hasSystemGit())) {
    progress(setupWin, { phase: "starting", message: "Setting up Git…", status: "active" });
    const provisioned = await ensureMinGit({
      installRoot: path.join(app.getPath("userData"), "mingit"),
      onLine: (line) => {
        debug(`git provision: ${line}`);
        progress(setupWin, { phase: "starting", message: line, status: "active" });
      },
    });
    if (provisioned) {
      process.env.PATH = `${process.env.PATH ?? ""};${provisioned.cmdDir}`;
      if (provisioned.bashPath && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = provisioned.bashPath;
      }
    }
    // null → offline or blocked: boot proceeds; template/deploy flows surface
    // the actionable GIT_NOT_INSTALLED remedy when actually used.
  }

  // Refresh installed providers before doctor/session creation. A newer Codex
  // model catalog belongs to the new CLI process, not to the Studio app bundle.
  const managedAgents = await ensureAgentUpdates({
    root: path.join(app.getPath("userData"), "agent-versions"),
    runtime: { binary: process.execPath, binaryArgs: [], binaryEnv: { ELECTRON_RUN_AS_NODE: "1" } },
    enabled: !devMode && !smoke && process.env.SAPIOM_DISABLE_AGENT_UPDATES !== "1",
    signal: mode.signal,
    install: installAgentVersion,
    probe: async (command) => {
      try {
        const target = resolveSpawnTarget(command.binary, [...command.binaryArgs, "--version"]);
        const result = await runUpdateCommand(target.command, target.args, {
          env: { ...process.env, ...command.binaryEnv, DISABLE_AUTOUPDATER: "1" },
          timeoutMs: 5_000,
        });
        return result.ok ? result.stdout.trim() : null;
      } catch { return null; }
    },
    onLine: (line) => {
      console.log(`[boot] agent-update: ${line}`);
      progress(setupWin, { phase: "installing-agent", message: line, status: "active" });
    },
  });
  const managedBins = Object.values(managedAgents).map(({ prefix }) =>
    process.platform === "win32" ? prefix : path.join(prefix, "bin"));
  if (managedBins.length) process.env.PATH = [...managedBins, process.env.PATH ?? ""].join(path.delimiter);
  mode.signal?.throwIfAborted();

  // 2. Doctor.
  progress(setupWin, { phase: "doctor", message: "Checking your environment…", status: "active" });
  let report = await runDoctor();

  // 3. Agent presence. If no coding agent is on PATH, auto-install the default
  //    (Claude Code) behind a "Setting up…" screen, then re-run doctor; on
  //    failure, fall back to a retryable guided-install screen. Dev-only
  //    SAPIOM_FORCE_NO_AGENT=1 forces this branch to exercise auto-install.
  //    Smoke mode never installs: it must not need the network, and its job is
  //    to prove the packaged bundle boots, not to re-test Phase 3. A missing
  //    agent there is reported by the checks, not fixed here.
  const forceNoAgent = devMode && process.env.SAPIOM_FORCE_NO_AGENT === "1";
  if (!smoke && (forceNoAgent || report.availableHarnesses.length === 0)) {
    report = await ensureAgentAvailable(setupWin, report);
  }

  // 3a. Windows: doctor's presence check (`where`) finds `claude.CMD` even when
  //     the shim's target binary is gone — the state Claude Code's own native
  //     auto-updater left one machine in (renamed claude.exe → .old.<ts>, never
  //     wrote the replacement), after which EVERY session spawn failed while
  //     doctor stayed green. resolveSpawnTarget is the real oracle; when it
  //     refuses and the broken install is the app-managed one, re-run the
  //     (idempotent) npm install to put a working binary back.
  // BOTH global layouts: npm puts packages under `<prefix>/node_modules` on
  // Windows and `<prefix>/lib/node_modules` on POSIX (agent-install.ts).
  // Checking only the Windows shape meant the DISABLE_AUTOUPDATER opt-out
  // below silently never applied on macOS/Linux — leaving the very
  // self-updater that tears managed installs live on those platforms.
  const managedClaudeInstalled = (): boolean =>
    [
      path.join(agentPrefixDir(), "node_modules", "@anthropic-ai", "claude-code"),
      path.join(agentPrefixDir(), "lib", "node_modules", "@anthropic-ai", "claude-code"),
    ].some((dir) => fs.existsSync(dir));
  if (!smoke && !managedAgents["claude-code"] && report.availableHarnesses.includes("claude-code")) {
    const decision = agentRepairDecision({
      platform: process.platform,
      managedInstallExists: managedClaudeInstalled(),
      checkSpawn: () => void resolveSpawnTarget("claude", []),
    });
    if (decision.repair) {
      debug(`agent repair: ${decision.reason ?? "spawn check failed"}`);
      progress(setupWin, { phase: "installing-agent", message: "Repairing Claude Code…", status: "active" });
      await installClaudeCode((line) => {
        progress(setupWin, { phase: "installing-agent", message: line, status: "active" });
      });
      report = await runDoctor();
    }
  }

  // 3b'. The agent's own self-updater must not mutate an install the app
  //      manages: in-place update of a running exe is exactly what produced the
  //      .old wreckage above, and the app repairs/refreshes the install itself
  //      via npm. DISABLE_AUTOUPDATER is Claude Code's documented opt-out; it
  //      rides process.env into every session the server spawns. Never set when
  //      the user runs their own claude (their install, their update policy) —
  //      the managed prefix is prepended to PATH, so when it exists it IS the
  //      active claude.
  if (managedAgents["claude-code"] || managedClaudeInstalled()) {
    process.env.DISABLE_AUTOUPDATER = "1";
    debug("managed Claude Code install detected — agent self-updater disabled for sessions");
  }

  progress(setupWin, { phase: "doctor", message: `Found: ${report.availableHarnesses.join(", ")}`, status: "done" });

  // 3b. The `sapiom` CLI. The agent is told to run `sapiom agents deploy` /
  //     `run --target local|prod` (harness macros) and `sapiom agents init`
  //     (templates), and nothing shipped that binary — so on a machine without a
  //     global install the agent hit `command not found` and improvised. Install
  //     it into the same per-user prefix as the agent; PATH already includes that
  //     dir, so it resolves on this same launch.
  //
  //     Non-fatal on purpose, and NOT gated behind a doctor failure: every direct
  //     in-app action (Deploy, Local Run) works without it, so a failed install
  //     must never block boot — it just leaves the agent-driven doors degraded,
  //     which is exactly the state we shipped. Skipped in smoke (no network on
  //     CI) and in dev (workspace copy) — see install-policy.ts.
  try {
    const cli = await ensureSapiomCli({ smoke, devMode }, (line) => debug(`sapiom-cli: ${line}`));
    debug(
      cli.install
        ? `sapiom CLI install ${cli.result?.ok ? "ok" : `FAILED (exit ${cli.result?.code ?? "?"})`} — ${cli.reason}`
        : `sapiom CLI: ${cli.reason}`,
    );
  } catch (err) {
    debug(`sapiom CLI install threw (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3c. The local sapiom-dev MCP server, installed into the same prefix so
  //     sessions launch it as `<this app binary> <entry.js>` (Electron-as-Node)
  //     instead of `npx @sapiom/mcp@latest`. On Windows the npx chain's cmd.exe
  //     sat as a PERSISTENT blank console window (Claude Code spawns without
  //     windowsHide); users closed it, killing the MCP server, after which
  //     every sapiom-dev tool call hung. A GUI-subsystem launcher can never
  //     have that window. Non-fatal: null falls back to the npx config —
  //     exactly the previous behavior. See mcp-install.ts.
  // console.log (not debug()): these land in main.log unconditionally — the
  // one-line-per-boot breadcrumb that turns "sessions still use npx, why?"
  // from a remote guessing game into a file read.
  let sapiomDevMcpEntry: string | null = null;
  try {
    sapiomDevMcpEntry = await ensureSapiomMcp({
      prefix: agentPrefixDir(),
      smoke,
      devMode,
      install: installSapiomMcp,
      onLine: (line) => console.log(`[boot] sapiom-mcp: ${line}`),
    });
    console.log(
      sapiomDevMcpEntry
        ? `[boot] sapiom-dev MCP: launching sessions via app binary + ${sapiomDevMcpEntry}`
        : "[boot] sapiom-dev MCP: no local install — sessions use the npx launch",
    );
  } catch (err) {
    console.log(`[boot] sapiom-mcp setup threw (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Machine id + first-run. "First run" means the user has never completed
  //    onboarding — i.e. no settings file has ever been persisted — NOT "has no
  //    recent dirs". Keying on recentDirs (as this once did) re-ran the whole
  //    first-run experience — the telemetry consent prompt included — for a
  //    RETURNING user whose recent dirs had all been pruned as dead (deleted or
  //    moved projects, see pruneDeadRecentDirs), so the app "always ran as first
  //    run". hasStoredSettings is the same signal the CLI's consent flow keys
  //    on. Read BEFORE recordRecentDir below creates the settings file (after
  //    that it is always true).
  const machineId = await getOrCreateMachineId();
  const firstRun = !(await hasStoredSettings());

  // 5. Auth. Probe for a cached credential first (non-interactive) so we can
  //    show the right message: a cached credential signs in instantly; without
  //    one we must open the browser and tell the user to complete sign-in there
  //    (otherwise the window just sits on a vague "Signing you in…").
  progress(setupWin, { phase: "auth", message: "Signing you in…", status: "active" });
  //    Smoke mode stops at the cached probe: an interactive sign-in would open
  //    a browser and block forever on a CI runner. Booting unauthenticated is a
  //    supported state (identity is optional to startServer).
  let identity: HarnessIdentity | null = await ensureAuthenticated({ interactive: false });
  if (!identity && !smoke) {
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
  const { telemetryOptIn, consentSource } = await decideConsent(setupWin, devMode || smoke, firstRun);

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

  // Test-only seam (smoke mode): point the claude-code adapter at a stub script
  // so `--smoke` can create a REAL session — spawning a real pty through the
  // real server — on a machine with no coding agent installed. This is what gives
  // us per-OS coverage of session creation, the step that broke on Windows while
  // every green test tier ran on Linux or in mock mode. Ignored outside --smoke.
  const stubAgent = smoke ? process.env.SAPIOM_SMOKE_STUB_AGENT : undefined;
  const stubbedHarnesses = stubAgent ? (["claude-code"] as const) : null;
  if (stubAgent) debug(`smoke: stubbing the claude-code agent with ${stubAgent}`);

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
    // NEW projects go one level down, in `projects/`, not directly into
    // launchDir. On this host launchDir is `~/.sapiom/harness` — the harness's
    // own state store (sessions.json, settings.json, workflows.json,
    // machine-id, generated/) — so creating user projects as its direct
    // children would interleave code with state and make "clear my state" and
    // "delete my agents" the same gesture. The seeded sample already uses a
    // containing subfolder (`sample-project/`), and the rail discovers projects
    // by scanning recursively for the marker, so nesting costs nothing.
    //
    // launchDir itself must stay put: it is the scan root, and moving it would
    // orphan the seeded sample from the rail.
    projectRoot: path.join(launchDir, "projects"),
    // Console-free sapiom-dev MCP launch (see 3c above). ELECTRON_RUN_AS_NODE
    // rides the MCP config's own env block, so it applies to exactly this
    // child and never leaks into the session at large.
    ...(sapiomDevMcpEntry
      ? {
          sapiomDevMcp: {
            command: process.execPath,
            args: [sapiomDevMcpEntry],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
        }
      : {}),
    autoCreateSession: !firstRun,
    defaultHarnessKind: stubbedHarnesses ? "claude-code" : pickDefaultHarness(report),
    availableHarnesses: stubbedHarnesses ? [...stubbedHarnesses] : report.availableHarnesses,
    firstRun,
    adapters: {
      "claude-code": createClaudeCodeAdapter(stubAgent ? { binary: stubAgent } : managedAgents["claude-code"]?.command),
      codex: createCodexAdapter(managedAgents.codex?.command),
    },
  });

  // 9. Load the SPA in the main window; close setup once it renders.
  const url = withDeepLinkParams(
    `http://127.0.0.1:${server.port}/?uiToken=${server.uiToken}`,
    mode.deepLink,
  );
  const mainWindow = createMainWindow(url);
  mainWindow.webContents.once("did-finish-load", () => {
    if (!setupWin.isDestroyed()) setupWin.close();
  });
  progress(setupWin, { phase: "ready", message: "Ready.", status: "done" });

  return { server, mainWindow, bootToken, url };
}

/**
 * Thread a cold-start deep link's target onto the SPA load URL as query params.
 * Query only — never a path segment: `isTrustedSender` (trusted-sender.ts) fails
 * closed unless the top frame's pathname is exactly "/", so a path-based route
 * here would break the update + folder-picker IPC. The SPA reads these back in
 * `web/src/lib/deep-link.ts`.
 */
function withDeepLinkParams(loadUrl: string, target: DeepLinkTarget | undefined): string {
  if (!target) return loadUrl;
  try {
    const u = new URL(loadUrl);
    if (target.kind === "agent") {
      u.searchParams.set("agent", target.definitionId);
      if (target.slug) u.searchParams.set("agentSlug", target.slug);
    } else {
      u.searchParams.set("template", target.templateId);
      if (target.slug) u.searchParams.set("templateSlug", target.slug);
    }
    return u.toString();
  } catch {
    return loadUrl;
  }
}
