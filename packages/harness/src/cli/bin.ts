#!/usr/bin/env node
/**
 * sapiom-harness CLI entry (workstream W4).
 *
 * Flow: doctor → auth (reuse @sapiom/mcp browser OAuth) → consent (first run)
 * → generate boot token → startServer → open browser → print a startup banner.
 *
 * Flags: [dir] (default cwd), --port, --no-auth, --no-telemetry, --no-open,
 * --no-session, --dev.
 */
import * as path from "node:path";
import * as crypto from "node:crypto";
import open from "open";
import { DEFAULT_PORT } from "../shared/types.js";
import { runDoctor, printDoctorReport } from "./doctor.js";
import { ensureAuthenticated, type HarnessIdentity } from "./auth.js";
import { ensureConsent } from "./consent.js";
import { recordRecentDir } from "./settings.js";
import { getOrCreateMachineId } from "./machine-id.js";
import { startServer, type HarnessServer } from "../server/index.js";

interface CliOptions {
  dir: string;
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
    ? `${opts.identity.organizationName} (${opts.identity.userId})`
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
  const options = parseArgs(process.argv.slice(2));

  const doctorReport = await runDoctor();
  printDoctorReport(doctorReport);
  if (!doctorReport.ok) {
    console.error(
      "\nsapiom-harness requires Node >= 20 and the `claude` CLI on PATH. Fix the checks above and try again.",
    );
    process.exit(1);
  }

  const machineId = await getOrCreateMachineId();

  const identity = await ensureAuthenticated({ interactive: true, noAuth: options.noAuth });
  const telemetryOptIn = await ensureConsent({ noTelemetry: options.noTelemetry });
  await recordRecentDir(options.dir);

  const bootToken = crypto.randomBytes(32).toString("hex");

  let server: HarnessServer | null = null;
  try {
    server = await startServer({
      port: options.port,
      bootToken,
      telemetryOptIn,
      identity,
      machineId,
      launchDir: options.dir,
      autoCreateSession: !options.noSession,
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
    telemetryOptIn,
    serverStarted: server !== null,
  });

  if (server && !options.noOpen) {
    await open(`http://localhost:${server.port}/?token=${bootToken}`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
