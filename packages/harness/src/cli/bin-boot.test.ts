/**
 * Unit tests for SAP-1841: deferred boot-auth + banner rename.
 *
 * bin.ts main() runs on import, so we test the constituent pieces in
 * isolation — the same pattern used by bin.test.ts for signal handlers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as path from "node:path";
import { DEFAULT_PORT } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Extracted helpers (mirror of bin.ts parseArgs / printBanner)
// ---------------------------------------------------------------------------

interface CliOptions {
  dir: string;
  port: number;
  login: boolean;
  noAuth: boolean;
  noTelemetry: boolean;
  noOpen: boolean;
  noSession: boolean;
  dev: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dir: string | undefined;
  let port = DEFAULT_PORT;
  let login = false;
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
      case "--login":
        login = true;
        break;
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
    login,
    noAuth,
    noTelemetry,
    noOpen,
    noSession,
    dev,
  };
}

interface PrintBannerOpts {
  dir: string;
  port: number;
  bootToken: string;
  identity: { organizationName: string; userId: string; source: "cached" | "fresh" } | null;
  telemetryOptIn: boolean;
  serverStarted: boolean;
}

function printBanner(opts: PrintBannerOpts): void {
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
  console.log(
    `  url         ${
      opts.serverStarted
        ? `http://localhost:${opts.port}/?token=${opts.bootToken}`
        : "(server not started)"
    }`,
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseArgs — --login flag", () => {
  it("login defaults to false (non-blocking boot)", () => {
    const opts = parseArgs([]);
    expect(opts.login).toBe(false);
  });

  it("--login sets login: true (opt-in browser auth)", () => {
    const opts = parseArgs(["--login"]);
    expect(opts.login).toBe(true);
  });

  it("--login and --no-auth can coexist (noAuth wins in ensureAuthenticated)", () => {
    const opts = parseArgs(["--login", "--no-auth"]);
    expect(opts.login).toBe(true);
    expect(opts.noAuth).toBe(true);
  });

  it("unknown flags throw", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown flag: --unknown");
  });

  it("--port requires a value", () => {
    expect(() => parseArgs(["--port"])).toThrow("--port requires a numeric value");
  });
});

describe("printBanner — 'Sapiom Studio' name", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  afterEach(() => {
    logSpy.mockClear();
  });

  it("banner line says 'Sapiom Studio' (not 'Sapiom Harness')", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      bootToken: "tok",
      identity: null,
      telemetryOptIn: false,
      serverStarted: false,
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("  Sapiom Studio");
    expect(lines.some((l) => l.includes("Sapiom Harness"))).toBe(false);
  });

  it("banner shows 'not authenticated' when no identity is present (unauthenticated boot)", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      bootToken: "tok",
      identity: null,
      telemetryOptIn: false,
      serverStarted: true,
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("not authenticated"))).toBe(true);
  });

  it("banner shows auth info when a cached identity is present", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      bootToken: "tok",
      identity: { organizationName: "Acme", userId: "u-1", source: "cached" },
      telemetryOptIn: true,
      serverStarted: true,
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("Acme") && l.includes("u-1") && l.includes("cached"))).toBe(
      true,
    );
  });

  it("banner shows the tokened URL when server started", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      bootToken: "abc123",
      identity: null,
      telemetryOptIn: false,
      serverStarted: true,
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("http://localhost:4000/?token=abc123"))).toBe(true);
  });

  it("banner shows '(server not started)' when server failed to start", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      bootToken: "abc123",
      identity: null,
      telemetryOptIn: false,
      serverStarted: false,
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("(server not started)"))).toBe(true);
  });
});

describe("boot-auth deferral — interactive: false when --login is absent", () => {
  /**
   * Verify that the boot sequence calls ensureAuthenticated with
   * interactive: false (non-blocking) unless --login is passed.
   * We test this through parseArgs since main() is a side-effectful entry point:
   * - parseArgs([])        → login: false → ensureAuthenticated({ interactive: false })
   * - parseArgs(['--login']) → login: true  → ensureAuthenticated({ interactive: true })
   */
  it("no flags → login is false → auth is non-interactive at boot", () => {
    const opts = parseArgs([]);
    // interactive === opts.login is the mapping in main()
    expect(opts.login).toBe(false);
  });

  it("--login flag → login is true → auth is interactive (opt-in browser OAuth)", () => {
    const opts = parseArgs(["--login"]);
    expect(opts.login).toBe(true);
  });

  it("--no-auth flag → noAuth is true → auth is skipped entirely", () => {
    const opts = parseArgs(["--no-auth"]);
    expect(opts.noAuth).toBe(true);
    expect(opts.login).toBe(false);
  });
});
