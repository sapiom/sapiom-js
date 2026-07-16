#!/usr/bin/env node
/**
 * sapiom-harness CLI entry (workstream W4).
 *
 * Flow: doctor → auth (reuse @sapiom/mcp browser OAuth) → consent (first run)
 * → generate boot token → startServer → open browser → print a startup banner.
 *
 * Flags: [dir] (default cwd), --port, --no-auth, --no-telemetry, --no-open,
 * --no-session, --dev.
 *
 * Passthrough mode: `sapiom-harness [harness-flags] -- <agent> [args...]`
 * (agent: `claude` | `claude-code` | `codex`) routes the whole invocation to
 * cli/passthrough.ts instead — the agent runs in this terminal with the
 * harness's config injection + analytics attached. The `--` separator is
 * mandatory; see cli/passthrough-args.ts for the grammar.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import open from "open";
import { DEFAULT_PORT } from "../shared/types.js";
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
import { parsePassthroughArgv, suggestPassthroughHint } from "./passthrough-args.js";
import { runPassthrough } from "./passthrough.js";
import { startServer, type HarnessServer } from "../server/index.js";

interface CliOptions {
  dir: string;
  /** The dir positional exactly as typed (undefined when defaulted to cwd) —
   *  drives the passthrough "did you mean" hint for agent-named dirs. */
  rawDir: string | undefined;
  port: number;
  noAuth: boolean;
  noTelemetry: boolean;
  noOpen: boolean;
  noSession: boolean;
  dev: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dir: string | undefined;
  let port = DEFAULT_PORT;
  let noAuth = false;
  let noTelemetry = false;
  let noOpen = false;
  let noSession = false;
  let dev = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port": {
        const value = argv[++i];
        if (!value || Number.isNaN(Number(value))) {
          throw new Error("--port requires a numeric value");
        }
        port = Number(value);
        break;
      }
      case "--no-auth":
        noAuth = true;
        break;
      case "--no-telemetry":
        noTelemetry = true;
        break;
      case "--no-open":
        noOpen = true;
        break;
      case "--no-session":
        noSession = true;
        break;
      case "--dev":
        dev = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        if (dir !== undefined) {
          throw new Error(`Unexpected extra argument: ${arg}`);
        }
        dir = arg;
    }
  }

  return {
    dir: path.resolve(dir ?? process.cwd()),
    rawDir: dir,
    port,
    noAuth,
    noTelemetry,
    noOpen,
    noSession,
    dev,
  };
}

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
  console.log("  Sapiom Harness");
  console.log("  --------------");
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
  // CLI passthrough mode: `sapiom-harness -- claude [args...]` runs the agent
  // in this terminal instead of booting the web UI. A null return means no
  // `--` was present — the web path below owns the argv unchanged.
  const passthrough = parsePassthroughArgv(process.argv.slice(2));
  if (passthrough) {
    process.exitCode = await runPassthrough(passthrough);
    return;
  }

  const options = parseArgs(process.argv.slice(2));

  // The dir positional shares its spot with what LOOKS like a passthrough
  // invocation missing its `--` (`sapiom-harness claude`). When an
  // agent-named dir doesn't actually exist the user almost certainly meant
  // passthrough — fail fast with the pointer instead of booting the web UI
  // against a nonexistent launch dir. An agent-named dir that DOES exist is
  // served as a normal directory, and non-agent positionals keep their
  // existing (unvalidated) behavior.
  const passthroughHint = options.rawDir === undefined ? null : suggestPassthroughHint(options.rawDir);
  if (passthroughHint && !existsSync(options.dir)) {
    throw new Error(`Directory not found: ${options.dir}\n${passthroughHint}`);
  }

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

  const machineId = await getOrCreateMachineId();

  const identity = await ensureAuthenticated({ interactive: true, noAuth: options.noAuth });
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
  const firstRun = (await loadSettings()).recentDirs.length === 0;
  await recordRecentDir(options.dir);

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
