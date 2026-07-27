/**
 * CLI argument parsing, split out of bin.ts so it can be TESTED.
 *
 * bin.ts self-executes (`main().catch(...)`), so importing it from a test would
 * boot the whole CLI. That is why bin-boot.test.ts used to carry a hand-copied
 * MIRROR of this function — a copy that could (and did) drift from the real
 * one, and which meant a new flag could ship with passing tests that never
 * exercised it. This module is the single implementation both use.
 */
import * as path from "node:path";
import { DEFAULT_PORT } from "../shared/types.js";

export interface CliOptions {
  dir: string;
  port: number;
  login: boolean;
  noAuth: boolean;
  noTelemetry: boolean;
  noOpen: boolean;
  noSession: boolean;
  dev: boolean;
  /** Override the state root (default `~/.sapiom/harness`). Lets a throwaway
   *  root stand in for a fresh install — the first-run flow becomes testable
   *  without moving, renaming, or losing the real one. */
  stateRoot?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  let dir: string | undefined;
  let port = DEFAULT_PORT;
  let login = false;
  let noAuth = false;
  let noTelemetry = false;
  let noOpen = false;
  let noSession = false;
  let dev = false;
  let stateRoot: string | undefined;

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
      case "--login":
        login = true;
        break;
      case "--no-auth":
        noAuth = true;
        break;
      case "--no-telemetry":
        noTelemetry = true;
        break;
      case "--state-root": {
        const value = argv[++i];
        if (!value) throw new Error("--state-root requires a directory path");
        stateRoot = value;
        break;
      }
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
    login,
    noAuth,
    noTelemetry,
    noOpen,
    noSession,
    dev,
    ...(stateRoot ? { stateRoot } : {}),
  };
}
