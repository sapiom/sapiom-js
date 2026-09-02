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

  async function writeCredentialsFile(file: unknown): Promise<void> {
    const sapiomDir = path.join(tmpDir, ".sapiom");
    await fs.mkdir(sapiomDir, { recursive: true });
    await fs.writeFile(
      path.join(sapiomDir, "credentials.json"),
      JSON.stringify(file),
      "utf-8",
    );
  }

  it("writes a config file under generated/<sessionId>/", async () => {
    const filePath = await generateMcpConfig("session-123");
    expect(filePath).toBe(
      path.join(
        tmpDir,
        ".sapiom",
        "harness",
        "generated",
        "session-123",
        "mcp-config.json",
      ),
    );

    const raw = await fs.readFile(filePath, "utf-8");
    const config = JSON.parse(raw);

    expect(config.mcpServers.sapiom).toEqual({
      type: "http",
      url: "https://api.sapiom.ai/v1/mcp",
    });
    expect(config.mcpServers["sapiom-dev"]).toEqual({
      command: "npx",
      // Dist-tagged so npx resolves the published package, not a local
      // workspace copy when the harness runs inside the monorepo.
      args: ["-y", "@sapiom/mcp@latest"],
    });
  });

  it("launches sapiom-dev via the host-supplied command when devServer is given", async () => {
    // The desktop host passes its own GUI-subsystem binary (Electron-as-Node):
    // on Windows the default npx chain's cmd.exe sat as a persistent visible
    // console window that users closed — killing the MCP server. The
    // launcher's env must merge WITH the shared entries and win on conflicts
    // (ELECTRON_RUN_AS_NODE is what makes the command a node at all).
    const filePath = await generateMcpConfig("session-dev", {
      environment: "staging",
      devServer: {
        command: "C:\\Apps\\Sapiom.exe",
        args: ["C:\\prefix\\node_modules\\@sapiom\\mcp\\dist\\index.js"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers["sapiom-dev"]).toEqual({
      command: "C:\\Apps\\Sapiom.exe",
      args: ["C:\\prefix\\node_modules\\@sapiom\\mcp\\dist\\index.js"],
      env: { SAPIOM_ENVIRONMENT: "staging", ELECTRON_RUN_AS_NODE: "1" },
    });
    // The remote entry is untouched by the override.
    expect(config.mcpServers.sapiom.type).toBe("http");
  });

  it("passes SAPIOM_ENVIRONMENT through to the sapiom-dev entry when set", async () => {
    const filePath = await generateMcpConfig("session-456", {
      environment: "staging",
    });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers["sapiom-dev"].env).toEqual({
      SAPIOM_ENVIRONMENT: "staging",
    });
  });

  it.each(["staging", "dev"])(
    "routes the remote sapiom MCP to staging for the %s environment",
    async (environment) => {
      const filePath = await generateMcpConfig(`session-${environment}`, {
        environment,
      });
      const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

      expect(config.mcpServers.sapiom.url).toBe(
        "https://api.sapiom.dev/v1/mcp",
      );
    },
  );

  it("preserves the prod alias for the production endpoint", async () => {
    const filePath = await generateMcpConfig("session-prod-alias", {
      environment: "prod",
    });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers.sapiom.url).toBe("https://api.sapiom.ai/v1/mcp");
  });

  it("uses SAPIOM_ENVIRONMENT before the credential file's current environment", async () => {
    await writeCredentialsFile({
      currentEnvironment: "staging",
      environments: {},
    });
    process.env.SAPIOM_ENVIRONMENT = "production";

    const filePath = await generateMcpConfig("session-process-env");
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers.sapiom.url).toBe("https://api.sapiom.ai/v1/mcp");
  });

  it("uses the credential file's current custom environment and normalizes its API URL", async () => {
    await writeCredentialsFile({
      currentEnvironment: "local",
      environments: {
        local: {
          appURL: "http://localhost:2999",
          apiURL: "http://localhost:3000/",
        },
      },
    });

    const filePath = await generateMcpConfig("session-custom");
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers.sapiom.url).toBe("http://localhost:3000/v1/mcp");
  });

  it("rejects an unknown custom environment instead of routing it to production", async () => {
    await expect(
      generateMcpConfig("session-unknown", { environment: "unknown" }),
    ).rejects.toThrow('Unknown environment "unknown"');
  });

  it("advertises the harness version so feedback records can name the build", async () => {
    const filePath = await generateMcpConfig("session-457", {
      harnessVersion: "0.2.5",
    });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers["sapiom-dev"].env).toEqual({
      SAPIOM_HARNESS_VERSION: "0.2.5",
    });
  });

  it("carries environment and harness version together", async () => {
    const filePath = await generateMcpConfig("session-458", {
      environment: "staging",
      harnessVersion: "0.2.5",
    });
    const config = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(config.mcpServers["sapiom-dev"].env).toEqual({
      SAPIOM_ENVIRONMENT: "staging",
      SAPIOM_HARNESS_VERSION: "0.2.5",
    });
  });

  it("isolates sessions into separate directories", async () => {
    const a = await generateMcpConfig("session-a");
    const b = await generateMcpConfig("session-b");
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });

  it("adds an x-api-key header to the remote sapiom entry when an apiKey is given", async () => {
    const filePath = await generateMcpConfig("session-auth", {
      apiKey: "sk_live_test123",
    });
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
    const withoutOption = JSON.parse(
      await fs.readFile(await generateMcpConfig("session-1"), "utf-8"),
    );
    expect(withoutOption.mcpServers.sapiom.headers).toBeUndefined();

    const withNull = JSON.parse(
      await fs.readFile(
        await generateMcpConfig("session-2", { apiKey: null }),
        "utf-8",
      ),
    );
    expect(withNull.mcpServers.sapiom.headers).toBeUndefined();
  });

  it("writes the config file with owner-only permissions (it can carry a live API key)", async () => {
    const filePath = await generateMcpConfig("session-perm", {
      apiKey: "sk_live_test123",
    });
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("writes a private Agent Map HTTP entry without disturbing existing servers", async () => {
    const filePath = await generateMcpConfig("session-map", {
      agentMap: {
        url: "http://127.0.0.1:4123/mcp/agent-map",
        bearerToken: "map-secret",
      },
    });
    const config = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(config.mcpServers["agent-map"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:4123/mcp/agent-map",
      headers: { Authorization: "Bearer map-secret" },
    });
    expect(config.mcpServers.sapiom).toBeDefined();
    expect(config.mcpServers["sapiom-dev"]).toBeDefined();
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
