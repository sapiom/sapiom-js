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

    expect(config.mcpServers.sapiom).toEqual({
      type: "http",
      url: "https://api.sapiom.ai/v1/mcp",
    });
    expect(config.mcpServers["sapiom-dev"]).toEqual({
      command: "npx",
      args: ["-y", "@sapiom/mcp"],
    });
  });

  it("passes SAPIOM_ENVIRONMENT through to the sapiom-dev entry when set", async () => {
    const filePath = await generateMcpConfig("session-456", { environment: "staging" });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers["sapiom-dev"].env).toEqual({ SAPIOM_ENVIRONMENT: "staging" });
  });

  it("isolates sessions into separate directories", async () => {
    const a = await generateMcpConfig("session-a");
    const b = await generateMcpConfig("session-b");
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });

  it("adds an x-api-key header to the remote sapiom entry when an apiKey is given", async () => {
    const filePath = await generateMcpConfig("session-auth", { apiKey: "sk_live_test123" });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers.sapiom).toEqual({
      type: "http",
      url: "https://api.sapiom.ai/v1/mcp",
      headers: { "x-api-key": "sk_live_test123" },
    });
    // sapiom-dev (the local stdio MCP) authenticates itself separately via
    // its own sapiom_authenticate tool — it doesn't need the apiKey.
    expect(config.mcpServers["sapiom-dev"].headers).toBeUndefined();
  });

  it("omits headers entirely when apiKey is null or absent", async () => {
    const withoutOption = JSON.parse(await fs.readFile(await generateMcpConfig("session-1"), "utf-8"));
    expect(withoutOption.mcpServers.sapiom.headers).toBeUndefined();

    const withNull = JSON.parse(
      await fs.readFile(await generateMcpConfig("session-2", { apiKey: null }), "utf-8"),
    );
    expect(withNull.mcpServers.sapiom.headers).toBeUndefined();
  });

  it("writes the config file with owner-only permissions (it can carry a live API key)", async () => {
    const filePath = await generateMcpConfig("session-perm", { apiKey: "sk_live_test123" });
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
