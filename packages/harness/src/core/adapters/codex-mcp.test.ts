import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "./codex.js";
import type { SpawnSpec } from "../../shared/types.js";

function serverArg(spec: SpawnSpec, name: string): string | undefined {
  return spec.args.find((arg) =>
    new RegExp(`^mcp_servers\\.${name}-[a-f0-9]{12}=`).test(arg),
  );
}

function serverConfig(spec: SpawnSpec, name: string): string | undefined {
  const arg = serverArg(spec, name);
  return arg?.slice(arg.indexOf("=") + 1);
}

describe("Codex per-session MCP configuration", () => {
  let dir: string;
  let mcpConfigFile: string;
  const adapter = new CodexAdapter({ binary: "fake-codex" });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-codex-mcp-"));
    mcpConfigFile = join(dir, "mcp-config.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const options = () => ({
    harnessSessionId: "session-1",
    cwd: dir,
    mcpConfigFile,
  });
  const writeConfig = (mcpServers: unknown) =>
    writeFile(mcpConfigFile, JSON.stringify({ mcpServers }));

  it("attaches remote, local, and Agent Map MCP servers on launch and resume without putting credentials in argv", async () => {
    await writeConfig({
      sapiom: {
        type: "http",
        url: "https://api.sapiom.ai/v1/mcp",
        headers: { "x-api-key": "private-sapiom-api-key" },
      },
      "sapiom-dev": {
        command: "/Applications/Agent Studio.app/Contents/MacOS/Agent Studio",
        args: ["/Applications/Agent Studio.app/Contents/Resources/mcp.js"],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          SAPIOM_ENVIRONMENT: "staging",
          SAPIOM_HARNESS_VERSION: "0.14.0",
          SAPIOM_API_KEY: "private-stdio-api-key",
        },
      },
      "agent-map": {
        type: "http",
        url: "http://127.0.0.1:4312/mcp/agent-map",
        headers: { Authorization: "Bearer private-map-token" },
      },
    });
    const before = await readFile(mcpConfigFile, "utf8");
    const parentApiKey = process.env.SAPIOM_API_KEY;

    for (const spec of [
      adapter.launch(options()),
      adapter.resume("rollout-1", options()),
    ]) {
      const remote = serverArg(spec, "sapiom");
      expect(remote).toContain('"url" = "https://api.sapiom.ai/v1/mcp"');
      expect(remote).toContain(
        '"env_http_headers" = { "x-api-key" = "SAPIOM_CODEX_MCP_0_HEADER_0" }',
      );
      expect(spec.env.SAPIOM_CODEX_MCP_0_HEADER_0).toBe(
        "private-sapiom-api-key",
      );

      const local = serverArg(spec, "sapiom-dev");
      expect(local).toContain(
        '"command" = "/Applications/Agent Studio.app/Contents/MacOS/Agent Studio"',
      );
      expect(local).toContain(
        '"args" = ["/Applications/Agent Studio.app/Contents/Resources/mcp.js"]',
      );
      expect(local).toContain('"env_vars" = ["SAPIOM_API_KEY"]');
      expect(local).toContain(
        '"env" = { "ELECTRON_RUN_AS_NODE" = "1", "SAPIOM_ENVIRONMENT" = "staging", "SAPIOM_HARNESS_VERSION" = "0.14.0" }',
      );
      expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(spec.env.SAPIOM_ENVIRONMENT).toBeUndefined();
      expect(spec.env.SAPIOM_HARNESS_VERSION).toBeUndefined();
      expect(spec.env.SAPIOM_API_KEY).toBe("private-stdio-api-key");
      for (const variable of Object.keys(spec.env)) {
        expect(spec.args).toContain(
          `shell_environment_policy.set.${variable}=""`,
        );
      }

      const agentMap = serverArg(spec, "agent-map");
      expect(agentMap).toContain(
        '"env_http_headers" = { "Authorization" = "SAPIOM_CODEX_MCP_2_HEADER_0" }',
      );
      expect(spec.env.SAPIOM_CODEX_MCP_2_HEADER_0).toBe(
        "Bearer private-map-token",
      );
      expect(spec.args.join(" ")).not.toContain("private-");
      expect(spec.args.some((arg) => arg.startsWith("mcp_servers="))).toBe(
        false,
      );
    }
    expect(await readFile(mcpConfigFile, "utf8")).toBe(before);
    expect(process.env.SAPIOM_API_KEY).toBe(parentApiKey);
  });

  it("supports signed-out sessions and the default npx launcher", async () => {
    await writeConfig({
      sapiom: { type: "http", url: "https://api.sapiom.ai/v1/mcp" },
      "sapiom-dev": { command: "npx", args: ["-y", "@sapiom/mcp@latest"] },
    });
    const spec = adapter.launch(options());
    expect(serverConfig(spec, "sapiom")).toBe(
      '{ "url" = "https://api.sapiom.ai/v1/mcp" }',
    );
    expect(serverConfig(spec, "sapiom-dev")).toBe(
      '{ "command" = "npx", "args" = ["-y", "@sapiom/mcp@latest"] }',
    );
    expect(spec.env).toEqual({});
  });

  it("keeps the profile prompt and identifies stable MCP aliases unique to each Studio session", async () => {
    await writeConfig({ "sapiom-dev": { command: "node", args: ["mcp.js"] } });
    const systemPromptFile = join(dir, "system-prompt.txt");
    await writeFile(
      systemPromptFile,
      "Build useful agents.\nKeep the user's constraints.",
    );
    const opts = { ...options(), systemPromptFile };
    const launched = adapter.launch(opts);
    const resumed = adapter.resume("rollout", opts);
    const other = adapter.launch({ ...opts, harnessSessionId: "session-2" });
    const alias = serverArg(launched, "sapiom-dev")!
      .split("=")[0]
      .slice("mcp_servers.".length);
    expect(serverArg(resumed, "sapiom-dev")).toBe(
      serverArg(launched, "sapiom-dev"),
    );
    expect(serverArg(other, "sapiom-dev")).not.toBe(
      serverArg(launched, "sapiom-dev"),
    );
    for (const spec of [launched, resumed]) {
      const overrides = spec.args.filter((arg) =>
        arg.startsWith("developer_instructions="),
      );
      expect(overrides).toHaveLength(1);
      const prompt: string = JSON.parse(
        overrides[0].slice("developer_instructions=".length),
      );
      expect(prompt).toContain(
        "Build useful agents.\nKeep the user's constraints.",
      );
      expect(prompt).toContain(`sapiom-dev is registered as ${alias}`);
      expect(prompt).toContain("References to the original server names");
    }
  });

  it("reads regenerated credentials on resume instead of reusing launch credentials", async () => {
    const servers = (key: string) => ({
      sapiom: {
        type: "http",
        url: "https://api.sapiom.ai/v1/mcp",
        headers: { "x-api-key": key },
      },
    });
    await writeConfig(servers("old-session-key"));
    const launched = adapter.launch(options());
    await writeConfig(servers("new-session-key"));
    const resumed = adapter.resume("rollout-1", options());
    expect(launched.env.SAPIOM_CODEX_MCP_0_HEADER_0).toBe("old-session-key");
    expect(resumed.env.SAPIOM_CODEX_MCP_0_HEADER_0).toBe("new-session-key");
    expect(resumed.args.slice(0, 2)).toEqual(["resume", "rollout-1"]);
    expect(serverArg(resumed, "sapiom")).toBe(serverArg(launched, "sapiom"));
  });

  it("uses a newly issued Agent Map capability over the copy in the generated file", async () => {
    await writeConfig({
      "agent-map": {
        type: "http",
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: "Bearer old-token" },
      },
    });
    const spec = adapter.launch({
      ...options(),
      agentMapMcp: {
        url: "http://127.0.0.1:2/mcp",
        bearerToken: "fresh-token",
      },
    });
    expect(
      spec.args.filter((arg) => arg.startsWith("mcp_servers.agent-map-")),
    ).toHaveLength(1);
    expect(spec.args.join(" ")).toContain('"url" = "http://127.0.0.1:2/mcp"');
    expect(spec.args.join(" ")).not.toMatch(/old-token|fresh-token/);
    expect(spec.env).toEqual({ SAPIOM_AGENT_MAP_CAPABILITY: "fresh-token" });
  });

  it("escapes Windows paths, quotes, newlines, and TOML control characters", async () => {
    await writeConfig({
      "sapiom-dev": {
        command: 'C:\\Program Files\\Agent "Studio"\\node.exe',
        args: ["line\nnext\u007f", "C:\\mcp\\index.js"],
      },
    });
    const spec = adapter.launch(options());
    expect(serverConfig(spec, "sapiom-dev")).toBe(
      '{ "command" = "C:\\\\Program Files\\\\Agent \\"Studio\\"\\\\node.exe", "args" = ["line\\nnext\\u007f", "C:\\\\mcp\\\\index.js"] }',
    );
  });

  it.each([
    ["missing server map", {}],
    ["array server map", { mcpServers: [] }],
    [
      "dotted server name",
      { mcpServers: { "sapiom.injected": { command: "node" } } },
    ],
    [
      "wrong header type",
      {
        mcpServers: {
          sapiom: {
            type: "http",
            url: "https://api.sapiom.ai",
            headers: { "x-api-key": 42 },
          },
        },
      },
    ],
    [
      "unknown transport",
      { mcpServers: { sapiom: { type: "sse", url: "https://api.sapiom.ai" } } },
    ],
    [
      "mixed transports",
      {
        mcpServers: {
          sapiom: {
            type: "http",
            url: "https://api.sapiom.ai",
            command: "node",
          },
        },
      },
    ],
    [
      "non-string argument",
      { mcpServers: { "sapiom-dev": { command: "node", args: [42] } } },
    ],
    [
      "invalid env name",
      {
        mcpServers: {
          "sapiom-dev": { command: "node", env: { "bad=name": "private-key" } },
        },
      },
    ],
  ])(
    "rejects %s visibly instead of silently dropping MCP wiring",
    async (_label, config) => {
      await writeFile(mcpConfigFile, JSON.stringify(config));
      for (const launch of [
        () => adapter.launch(options()),
        () => adapter.resume("rollout", options()),
      ]) {
        expect(launch).toThrow(
          "Could not load the generated Codex MCP configuration. Start a new session to regenerate it.",
        );
      }
    },
  );

  it("does not expose JSON parser snippets or file paths when a credential-bearing file is malformed", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeFile(mcpConfigFile, 'private-api-key: "broken JSON"');
    expect(() => adapter.launch(options())).toThrow(
      /^Could not load the generated Codex MCP configuration\./,
    );
    try {
      adapter.launch(options());
    } catch (error) {
      expect(String(error)).not.toContain("private-api-key");
      expect(String(error)).not.toContain(mcpConfigFile);
    }
    expect(diagnostic.mock.calls.flat().join(" ")).toContain("Invalid JSON");
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain(
      "private-api-key",
    );
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain(mcpConfigFile);
    diagnostic.mockRestore();
  });

  it("fails visibly when the generated MCP file is unavailable", () => {
    expect(() => adapter.launch(options())).toThrow(
      "Could not load the generated Codex MCP configuration",
    );
  });
});
