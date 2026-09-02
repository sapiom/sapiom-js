import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import { startServer, type HarnessServer } from "./index.js";

let root: string;
let projectRoot: string;
let server: HarnessServer | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-mcp-wiring-"));
  projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  await new StudioProjectCatalog(path.join(root, "studio-projects.json")).reconcile([
    { workspaceKey: "project", cwd: projectRoot },
  ]);
});

afterEach(async () => {
  await server?.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

it("uses the actual ephemeral port and revokes private MCP launch authority on exit", async () => {
  let launchOpts: LaunchOpts | undefined;
  const launch = (opts: LaunchOpts): SpawnSpec => {
    launchOpts = opts;
    return { command: "bash", args: [], env: {}, cwd: opts.cwd };
  };
  const adapter: HarnessAdapter = {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch,
    resume: (_id, opts) => launch(opts),
    listPastSessions: async () => [],
    canResume: async () => true,
  };
  const webDir = path.join(root, "web");
  await fs.mkdir(webDir);
  await fs.writeFile(path.join(webDir, "index.html"), "<html></html>");
  server = await startServer({
    port: 0,
    bootToken: "boot-token",
    telemetryOptIn: false,
    identity: {
      userId: "user-1",
      tenantId: "tenant-1",
      organizationName: "Test",
      apiKey: "sk_test",
      source: "cached",
    },
    adapters: { "claude-code": adapter },
    stateRoot: root,
    launchDir: projectRoot,
    webDir,
    autoCreateSession: false,
    loadSystemPrompt: async () => "",
  });
  const session = await server.sessionManager.create({
    cwd: projectRoot,
    harness: "claude-code",
  });
  const metadata = launchOpts?.agentMapMcp;
  expect(metadata?.url).toBe(
    `http://127.0.0.1:${server.port}/mcp/agent-map`,
  );
  expect(metadata?.url).not.toContain(":0/");
  expect(launchOpts?.mcpConfigFile).toBeDefined();
  const config = JSON.parse(
    await fs.readFile(launchOpts!.mcpConfigFile!, "utf8"),
  );
  expect(config.mcpServers["agent-map"].headers.Authorization).toBe(
    `Bearer ${metadata!.bearerToken}`,
  );
  expect((await fs.stat(launchOpts!.mcpConfigFile!)).mode & 0o777).toBe(0o600);

  await server.sessionManager.kill(session.id);
  const rejected = await fetch(metadata!.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${metadata!.bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
  expect(rejected.status).toBe(401);
});
