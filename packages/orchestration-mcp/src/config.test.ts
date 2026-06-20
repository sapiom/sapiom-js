/**
 * Tests for host and API key resolution in config.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We use environment variable control to exercise the resolution paths
// without touching the real filesystem or ~/.sapiom/.

describe("resolveHost", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clear all sapiom-related env vars before each test
    delete process.env.SAPIOM_HOST;
    delete process.env.SAPIOM_TARGET;
    delete process.env.SAPIOM_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    Object.assign(process.env, ORIGINAL_ENV);
    // Remove keys that weren't in the original env
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
  });

  it("SAPIOM_HOST wins over everything", async () => {
    process.env.SAPIOM_HOST = "https://custom.example.com/";
    const { resolveHost } = await import("./config.js");
    expect(resolveHost()).toBe("https://custom.example.com");
  });

  it("strips trailing slash from SAPIOM_HOST", async () => {
    process.env.SAPIOM_HOST = "https://custom.example.com/";
    const { resolveHost } = await import("./config.js");
    expect(resolveHost()).toBe("https://custom.example.com");
  });

  it("SAPIOM_TARGET=local maps to localhost:3000", async () => {
    process.env.SAPIOM_TARGET = "local";
    const { resolveHost } = await import("./config.js");
    expect(resolveHost()).toBe("http://localhost:3000");
  });

  it("SAPIOM_TARGET=prod maps to production URL", async () => {
    process.env.SAPIOM_TARGET = "prod";
    const { resolveHost } = await import("./config.js");
    expect(resolveHost()).toBe("https://api.sapiom.ai");
  });

  it("defaults to production when no env vars or config are set", async () => {
    // Point XDG_CONFIG_HOME at an empty temp dir so we don't read real config
    process.env.XDG_CONFIG_HOME = "/tmp/sapiom-mcp-test-nonexistent";
    const { resolveHost } = await import("./config.js");
    expect(resolveHost()).toBe("https://api.sapiom.ai");
  });
});

describe("resolveApiKey", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SAPIOM_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    Object.assign(process.env, ORIGINAL_ENV);
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
  });

  it("returns SAPIOM_API_KEY when set", async () => {
    process.env.SAPIOM_API_KEY = "sk_test_abc123";
    const { resolveApiKey } = await import("./config.js");
    expect(resolveApiKey()).toBe("sk_test_abc123");
  });

  it("throws a helpful error when no credentials exist", async () => {
    // Point at a path with no credentials file
    process.env.XDG_CONFIG_HOME = "/tmp/sapiom-mcp-test-nonexistent";
    const { resolveApiKey } = await import("./config.js");
    expect(() => resolveApiKey()).toThrow(/SAPIOM_API_KEY/);
    expect(() => resolveApiKey()).toThrow(/sapiom login/);
  });
});
