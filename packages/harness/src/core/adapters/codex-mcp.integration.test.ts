/**
 * Opt-in vendor compatibility test: a real Codex process discovers the built
 * sapiom-dev server through Studio's generated config, without a model or login.
 * Run after building workspace dependencies with RUN_CODEX_MCP_INTEGRATION=1.
 * CODEX_TEST_BINARY can select an installed CLI version. All auth is synthetic,
 * all HTTP endpoints are loopback, and both homes are temporary.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { SpawnSpec } from "../../shared/types.js";
import { generateMcpConfig } from "../inject/mcp-config.js";
import { CodexAdapter } from "./codex.js";

interface McpStatus {
  name: string;
  serverInfo?: { name: string } | null;
  tools: Record<string, unknown>;
}

async function discover(spec: SpawnSpec, home: string): Promise<McpStatus[]> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    TMPDIR: process.env.TMPDIR,
    SAPIOM_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    // No vendor network is needed. Prevent optional Codex metadata fetches.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  };
  for (const [key, value] of Object.entries(spec.env)) {
    if (value !== null) env[key] = value;
  }
  // Launch/resume parity is covered by the adapter and lifecycle tests.
  // This probe verifies the real CLI's parsing and MCP discovery.
  const child = spawn(
    process.env.CODEX_TEST_BINARY ?? "codex",
    ["app-server", ...spec.args],
    { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  let id = 0;
  const fail = (): void => {
    for (const request of pending.values()) {
      request.reject(
        new Error("Codex MCP probe failed; check CLI compatibility."),
      );
    }
    pending.clear();
  };
  // Drain diagnostics, but never include subprocess output/config in failures.
  child.stderr.resume();
  child.on("error", fail);
  child.on("exit", fail);
  lines.on("line", (line) => {
    let response: { id?: number; error?: unknown; result?: unknown };
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    if (response.id === undefined) return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error("Codex MCP RPC failed."));
    else request.resolve(response.result);
  });
  const request = (method: string, params: unknown): Promise<unknown> => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ id: requestId, method, params }) + "\n",
      );
    });
  };
  const timeout = setTimeout(() => {
    fail();
    child.kill("SIGKILL");
  }, 25_000);
  try {
    await request("initialize", {
      clientInfo: { name: "sapiom_mcp_test", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const result = (await request("mcpServerStatus/list", {
      detail: "full",
    })) as {
      data: McpStatus[];
    };
    return result.data;
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve();
      const killTimeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => {
        clearTimeout(killTimeout);
        resolve();
      });
    });
  }
}

describe.skipIf(process.env.RUN_CODEX_MCP_INTEGRATION !== "1")(
  "real Codex Studio MCP discovery",
  () => {
    let root: string;
    let http: Server | undefined;
    const mcpConnections: McpServer[] = [];

    afterEach(async () => {
      vi.unstubAllEnvs();
      await Promise.all(
        mcpConnections.splice(0).map((server) => server.close()),
      );
      http?.closeAllConnections();
      await new Promise<void>((resolve) =>
        http ? http.close(() => resolve()) : resolve(),
      );
      http = undefined;
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });

    it.each([false, true])(
      "discovers authoring tools with existing global registrations=%s",
      async (existingRegistrations) => {
        root = await mkdtemp(join(tmpdir(), "studio-codex-mcp-"));
        const codexHome = join(root, ".codex");
        await mkdir(codexHome);
        await mkdir(join(root, ".sapiom"));
        const fixtureKey = "synthetic-integration-credential";
        let authenticated = false;
        http = createServer(async (req, res) => {
          if (req.url === "/v1/mcp/instructions") {
            res.end("Local authoring integration test.");
            return;
          }
          if (req.url !== "/v1/mcp" && req.url !== "/user-mcp") {
            res.writeHead(404).end();
            return;
          }
          if (req.url === "/v1/mcp") {
            if (req.headers["x-api-key"] !== fixtureKey) {
              res.writeHead(401).end();
              return;
            }
            authenticated = true;
          }
          const mcp = new McpServer({
            name: "loopback-capabilities",
            version: "1.0.0",
          });
          mcp.registerTool(
            "local_capability_probe",
            { inputSchema: {} },
            async () => ({
              content: [{ type: "text", text: "local" }],
            }),
          );
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          mcpConnections.push(mcp);
          await mcp.connect(transport);
          await transport.handleRequest(req, res);
        });
        await new Promise<void>((resolve) =>
          http!.listen(0, "127.0.0.1", resolve),
        );
        const address = http.address();
        if (!address || typeof address === "string")
          throw new Error("Missing test port");
        const apiURL = `http://127.0.0.1:${address.port}`;
        await writeFile(
          join(root, ".sapiom", "credentials.json"),
          JSON.stringify({
            currentEnvironment: "integration",
            environments: { integration: { apiURL, appURL: apiURL } },
          }),
        );
        vi.stubEnv("HOME", root);
        vi.stubEnv("SAPIOM_ENVIRONMENT", "integration");
        const globalConfig = [
          'model_provider = "integration"',
          'model = "integration"',
          "[model_providers.integration]",
          'name = "Integration"',
          'base_url = "http://127.0.0.1:9/v1"',
          'wire_api = "responses"',
          "requires_openai_auth = false",
          ...(existingRegistrations
            ? [
                // Opposite transport and stale auth must not contaminate Studio's
                // entries. Unrelated user servers remain present and unchanged.
                "[mcp_servers.sapiom]",
                'command = "unused-global-command"',
                "enabled = false",
                "[mcp_servers.sapiom-dev]",
                'url = "http://127.0.0.1:9/stale"',
                "enabled = false",
                "[mcp_servers.user-server]",
                `url = "${apiURL}/user-mcp"`,
              ]
            : []),
        ].join("\n");
        await writeFile(join(codexHome, "config.toml"), globalConfig);
        const mcpConfigFile = await generateMcpConfig("integration-session", {
          generatedRoot: join(root, "generated"),
          apiKey: fixtureKey,
          environment: "integration",
          devServer: {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL("../../../../mcp/dist/index.js", import.meta.url),
              ),
            ],
            env: {
              HOME: root,
              SAPIOM_TELEMETRY_DISABLED: "1",
              DO_NOT_TRACK: "1",
            },
          },
        });
        const adapter = new CodexAdapter();
        const opts = {
          cwd: root,
          harnessSessionId: "integration-session",
          mcpConfigFile,
        };
        const spec = adapter.launch(opts);
        authenticated = false;
        expect(spec.args.join(" ").includes(fixtureKey)).toBe(false);
        const servers = await discover(spec, root);
        const authoring = servers.find(
          (server) => server.serverInfo?.name === "sapiom-dev",
        );
        expect(Object.keys(authoring?.tools ?? {})).toContain(
          "sapiom_dev_agents_check",
        );
        const remote = servers.find(
          (server) =>
            server.serverInfo?.name === "loopback-capabilities" &&
            server.name !== "user-server",
        );
        expect(Object.keys(remote?.tools ?? {})).toContain(
          "local_capability_probe",
        );
        if (existingRegistrations) {
          expect(servers.map((server) => server.name)).toEqual(
            expect.arrayContaining(["sapiom", "sapiom-dev", "user-server"]),
          );
          expect(
            Object.keys(
              servers.find((server) => server.name === "user-server")
                ?.tools ?? {},
            ),
          ).toContain("local_capability_probe");
        }
        expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
          globalConfig,
        );
        expect(authenticated).toBe(true);
      },
      60_000,
    );
  },
);
