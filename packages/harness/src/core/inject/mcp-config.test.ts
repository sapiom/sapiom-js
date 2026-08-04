import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpDir };
});

import { generateMcpConfig } from "./mcp-config.js";

describe("generateMcpConfig", () => {
  const originalEnv = process.env.SAPIOM_ENVIRONMENT;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-mcp-config-"));
    delete process.env.SAPIOM_ENVIRONMENT;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.SAPIOM_ENVIRONMENT;
    else process.env.SAPIOM_ENVIRONMENT = originalEnv;
  });

  it("writes a config file under generated/<sessionId>/", async () => {
    const filePath = await generateMcpConfig("session-123");
    expect(filePath).toBe(
      path.join(tmpDir, ".sapiom", "harness", "generated", "session-123", "mcp-config.json"),
    );

    const raw = await fs.readFile(filePath, "utf-8");
    const config = JSON.parse(raw);

    expect(Object.keys(config.mcpServers).sort()).toEqual(["sapiom", "sapiom-direct"]);
    expect(config.mcpServers["sapiom-direct"]).toEqual({
      type: "http",
      url: "https://api.sapiom.ai/v1/mcp",
    });
    expect(config.mcpServers.sapiom).toEqual({
      command: "npx",
      // Dist-tagged so npx resolves the published package, not a local
      // workspace copy when the harness runs inside the monorepo.
      args: ["-y", "@sapiom/mcp@latest"],
    });
  });

  it("passes SAPIOM_ENVIRONMENT through to the local sapiom entry when set", async () => {
    const filePath = await generateMcpConfig("session-456", { environment: "staging" });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers.sapiom.env).toEqual({ SAPIOM_ENVIRONMENT: "staging" });
  });

  it("advertises the harness version so feedback records can name the build", async () => {
    const filePath = await generateMcpConfig("session-457", { harnessVersion: "0.2.5" });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers.sapiom.env).toEqual({
      SAPIOM_HARNESS_VERSION: "0.2.5",
    });
  });

  it("carries environment and harness version together", async () => {
    const filePath = await generateMcpConfig("session-458", {
      environment: "staging",
      harnessVersion: "0.2.5",
    });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers.sapiom.env).toEqual({
      SAPIOM_ENVIRONMENT: "staging",
      SAPIOM_HARNESS_VERSION: "0.2.5",
    });
  });

  it("isolates sessions into separate directories", async () => {
    const a = await generateMcpConfig("session-a");
    const b = await generateMcpConfig("session-b");
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });

  it("adds an x-api-key header to the hosted sapiom-direct entry when an apiKey is given", async () => {
    const filePath = await generateMcpConfig("session-auth", { apiKey: "sk_live_test123" });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers["sapiom-direct"]).toEqual({
      type: "http",
      url: "https://api.sapiom.ai/v1/mcp",
      headers: { "x-api-key": "sk_live_test123" },
    });
    // sapiom (the local stdio MCP alias) authenticates itself separately via
    // its own sapiom_authenticate tool — it doesn't need the apiKey.
    expect(config.mcpServers.sapiom.headers).toBeUndefined();
  });

  it("omits headers entirely when apiKey is null or absent", async () => {
    const withoutOption = JSON.parse(await fs.readFile(await generateMcpConfig("session-1"), "utf-8"));
    expect(withoutOption.mcpServers["sapiom-direct"].headers).toBeUndefined();

    const withNull = JSON.parse(
      await fs.readFile(await generateMcpConfig("session-2", { apiKey: null }), "utf-8"),
    );
    expect(withNull.mcpServers["sapiom-direct"].headers).toBeUndefined();
  });

  it("writes the config file with owner-only permissions (it can carry a live API key)", async () => {
    const filePath = await generateMcpConfig("session-perm", { apiKey: "sk_live_test123" });
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
