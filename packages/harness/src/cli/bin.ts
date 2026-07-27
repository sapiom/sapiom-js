#!/usr/bin/env node
/**
 * sapiom-harness CLI entry (workstream W4).
 *
 * Flow: doctor → auth (non-blocking: reuse cached credential if present, skip
 * browser OAuth at boot) → consent (first run) → generate boot token →
 * startServer → open browser → print a startup banner.
 *
 * The Studio launches unauthenticated when no cached credential exists; the
 * web app drives sign-in (D4/D5). Use --login to trigger an interactive
 * browser OAuth before the server starts.
 *
 * Flags: [dir] (default cwd), --port, --login, --no-auth, --no-telemetry,
 * --no-open, --no-session, --dev, --state-root <dir>.
 */
import * as crypto from "node:crypto";
import open from "open";
import {
  runDoctor,
  printDoctorReport,
  pickDefaultHarness,
  CLAUDE_INSTALL_COMMAND,
  CODEX_INSTALL_COMMAND,
} from "./doctor.js";
import { ensureAuthenticated, type HarnessIdentity } from "./auth.js";
import { ensureConsent } from "./consent.js";
import { loadSettings, recordRecentDir } from "./settings.js";
import { getOrCreateMachineId } from "./machine-id.js";
import { resolveStatePaths } from "../core/paths.js";
import { parseArgs } from "./args.js";
import { startServer, type HarnessServer } from "../server/index.js";

function printBanner(opts: {
  dir: string;
  port: number;
  bootToken: string;
  identity: HarnessIdentity | null;
  telemetryOptIn: boolean;
  serverStarted: boolean;
}): void {
  const authLine = opts.identity
    ? `${opts.identity.organizationName} (${opts.identity.userId})${
        opts.identity.source === "cached" ? " — cached" : ""
      }`
    : "not authenticated";

  console.log("");
  console.log("  Sapiom Studio");
  console.log("  -------------");
  console.log(`  directory   ${opts.dir}`);
  console.log(`  auth        ${authLine}`);
  console.log(`  telemetry   ${opts.telemetryOptIn ? "on" : "off"}`);
  // Always the full tokened URL — with --no-open (or a browser that failed
  // to launch) this is the only way to reach the app; a bare host:port
  // 401s on every /api call and can't open the WS connections.
  console.log(
    `  url         ${
      opts.serverStarted ? `http://localhost:${opts.port}/?token=${opts.bootToken}` : "(server not started)"
    }`,
  );
  console.log("");
}

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));

  const doctorReport = await runDoctor();
  printDoctorReport(doctorReport);
  if (!doctorReport.ok) {
    console.error(
      "\nsapiom-harness requires Node >= 20 and at least one coding agent on PATH:\n" +
        `  Claude Code:  ${CLAUDE_INSTALL_COMMAND}\n` +
        `  Codex:        ${CODEX_INSTALL_COMMAND}\n` +
        "Fix the checks above and try again.",
    );
    process.exit(1);
  }
  const defaultHarnessKind = pickDefaultHarness(doctorReport);
  if (!doctorReport.availableHarnesses.includes("claude-code")) {
    console.log(
      `\n⚠ Claude Code not found — install with: ${CLAUDE_INSTALL_COMMAND}\n` +
        "  Continuing with the Codex harness.",
    );
  }

  // Every piece of harness state resolves through ONE root, so --state-root
  // relocates all of it together. Without this, firstRun and recentDirs would
  // still read and WRITE the real settings file while everything else used the
  // throwaway root — a half-isolated run that silently mutates real state.
  const statePaths = resolveStatePaths(options.stateRoot);
  const machineId = await getOrCreateMachineId(statePaths.machineId);

  // Auth is non-blocking at boot: use a cached credential if one exists, but
  // never open a browser at startup. The Studio launches unauthenticated and
  // the web app drives sign-in (D4/D5). Pass --login to run an interactive
  // browser OAuth before the server starts.
  const identity = await ensureAuthenticated({
    interactive: options.login,
    noAuth: options.noAuth,
  });
  // A cached credential signs you in with no visible prompt at all — call it
  // out explicitly so "auth silently worked" doesn't read as "nothing
  // happened" (a fresh login is its own visible browser flow already).
  if (identity?.source === "cached") {
    console.log(`\nSigned in as ${identity.organizationName} (cached credential).`);
  }
  const consentResult = await ensureConsent({ noTelemetry: options.noTelemetry });
  const { telemetryOptIn } = consentResult;
  // First run = no recent directories recorded before this boot. Must be read
  // BEFORE recordRecentDir below stamps the launch dir in — after that the
  // signal is gone for good. Drives the SPA's welcome panel (AppState.firstRun)
  // and suppresses the auto-created boot session, so a brand-new user lands on
  // the welcome panel rather than a bare terminal in whatever directory they
  // happened to launch from.
  const firstRun = (await loadSettings(statePaths.settings)).recentDirs.length === 0;
  await recordRecentDir(options.dir, statePaths.settings);

  const bootToken = crypto.randomBytes(32).toString("hex");

  let server: HarnessServer | null = null;
  try {
    server = await startServer({
      port: options.port,
      bootToken,
      telemetryOptIn,
      consentSource: consentResult.source,
      consentEnvReason: consentResult.envReason,
      identity,
      machineId,
      launchDir: options.dir,
      ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
      autoCreateSession: !options.noSession && !firstRun,
      defaultHarnessKind,
      availableHarnesses: doctorReport.availableHarnesses,
      firstRun,
    });
  } catch (err) {
    if (!options.dev) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n⚠ Harness server is not wired up yet: ${message}`);
    console.error(
      "--dev flow verified (doctor → auth → consent) without a live server.\n",
    );
  }

  printBanner({
    dir: options.dir,
    port: server?.port ?? options.port,
    bootToken,
    identity,
    telemetryOptIn: consentResult.telemetryOptIn,
    serverStarted: server !== null,
  });

  if (server && !options.noOpen) {
    await open(`http://localhost:${server.port}/?token=${bootToken}`);
  }

  if (server) {
    // Wire SIGINT (Ctrl+C) and SIGTERM so the awaitable close() path actually
    // runs, which kills all live claude/codex ptys before the process exits.
    // Without this, server.close() is never called from the CLI and the pty
    // orphan problem the awaitable-kill feature was built to fix remains inert
    // in the primary usage path.
    // Guard against double-fire: once is enough; a second signal gets default
    // handling (immediate termination) which is the correct behavior anyway.
    let closing = false;
    const handleSignal = (signal: "SIGINT" | "SIGTERM"): void => {
      if (closing) return;
      closing = true;
      // server.close() is already race-bounded to 5s internally.
      void server!.close().finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    };
    process.once("SIGINT", () => handleSignal("SIGINT"));
    process.once("SIGTERM", () => handleSignal("SIGTERM"));
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
