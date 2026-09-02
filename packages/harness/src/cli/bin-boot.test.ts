/**
 * Unit tests for SAP-1841: deferred boot-auth + banner rename.
 *
 * bin.ts main() runs on import, so we test the constituent pieces in
 * isolation — the same pattern used by bin.test.ts for signal handlers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseArgs, resolveCliAuthMode } from "./args.js";
import { printBanner } from "./banner.js";
import { AGENT_STUDIO_PRODUCT_NAME } from "../shared/branding.js";

// ---------------------------------------------------------------------------
// parseArgs and printBanner are the REAL production implementations. bin.ts
// self-executes, so side-effect-free CLI behavior lives in importable modules.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseArgs — --state-root flag", () => {
  it("is absent by default, so the real state root is used", () => {
    expect(parseArgs([]).stateRoot).toBeUndefined();
  });

  it("captures the directory it is given", () => {
    expect(parseArgs(["--state-root", "/tmp/throwaway"]).stateRoot).toBe(
      "/tmp/throwaway",
    );
  });

  it("rejects a missing value rather than silently ignoring the flag", () => {
    expect(() => parseArgs(["--state-root"])).toThrow(
      /requires a directory path/,
    );
  });

  it("composes with a working directory argument", () => {
    const options = parseArgs([
      "/Users/demo/scratch",
      "--state-root",
      "/tmp/throwaway",
    ]);
    expect(options.dir).toBe("/Users/demo/scratch");
    expect(options.stateRoot).toBe("/tmp/throwaway");
  });
});

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
    expect(() => parseArgs(["--port"])).toThrow(
      "--port requires a numeric value",
    );
  });
});

describe("printBanner — 'Agent Studio' name", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  afterEach(() => {
    logSpy.mockClear();
  });

  it("banner line says 'Agent Studio' (not the legacy Studio or Harness names)", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      uiToken: "tok",
      identity: null,
      telemetryOptIn: false,
      serverStarted: false,
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(`  ${AGENT_STUDIO_PRODUCT_NAME}`);
    expect(lines.some((l) => l.includes("Sapiom Studio"))).toBe(false);
    expect(lines.some((l) => l.includes("Sapiom Harness"))).toBe(false);
  });

  it("banner shows 'not authenticated' when no identity is present (unauthenticated boot)", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      uiToken: "tok",
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
      uiToken: "tok",
      identity: { organizationName: "Acme", userId: "u-1", source: "cached" },
      telemetryOptIn: true,
      serverStarted: true,
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(
      lines.some(
        (l) => l.includes("Acme") && l.includes("u-1") && l.includes("cached"),
      ),
    ).toBe(true);
  });

  it("banner shows the UI-authorized launch URL when server started", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      uiToken: "abc123",
      identity: null,
      telemetryOptIn: false,
      serverStarted: true,
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(
      lines.some((l) => l.includes("http://localhost:4000/?uiToken=abc123")),
    ).toBe(true);
  });

  it("banner shows '(server not started)' when server failed to start", () => {
    printBanner({
      dir: "/some/dir",
      port: 4000,
      uiToken: "abc123",
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
    expect(resolveCliAuthMode(opts)).toBe("disabled");
  });

  it("auth remains enabled by default", () => {
    expect(resolveCliAuthMode(parseArgs([]))).toBe("enabled");
  });
});
