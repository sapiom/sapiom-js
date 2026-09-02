import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import { startServer, type HarnessServer } from "./index.js";

let root: string;
let projectRoot: string;
let projectId: string;
let server: HarnessServer | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-mcp-wiring-"));
  projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const reconciled = await new StudioProjectCatalog(
    path.join(root, "studio-projects.json"),
  ).reconcile([{ workspaceKey: "project", cwd: projectRoot }]);
  projectId = reconciled.projects[0]!.projectId;
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({ recentDirs: [projectRoot] }),
  );
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

  const client = new Client({ name: "full-server-wiring-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(metadata!.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${metadata!.bearerToken}` },
    },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map(({ name }) => name).sort()).toEqual([
    "agent_map_propose",
    "agent_map_read",
    "agent_map_validate",
  ]);
  const snapshot = await client.callTool({
    name: "agent_map_read",
    arguments: {},
  });
  expect(snapshot.isError).not.toBe(true);
  expect(snapshot.structuredContent).toMatchObject({
    schemaVersion: 1,
    project: { projectId: session.agentMapIdentity!.projectId },
    proposal: null,
  });
  await client.close();

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

it("gives a signed-out local planner its scoped Agent Map tools", async () => {
  const launches: LaunchOpts[] = [];
  const launch = (opts: LaunchOpts): SpawnSpec => {
    launches.push(opts);
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
    identity: null,
    machineId: "machine-1",
    adapters: { "claude-code": adapter },
    stateRoot: root,
    launchDir: projectRoot,
    webDir,
    autoCreateSession: false,
    loadSystemPrompt: async () => "",
  });

  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/projects/${projectId}/planner-sessions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harness-token": "boot-token",
      },
      body: JSON.stringify({ mode: "fresh", harness: "claude-code" }),
    },
  );
  expect(response.status).toBe(201);
  const created = (await response.json()) as {
    session: {
      id: string;
      planning: {
        identity: { role: string; userId: string };
        greeting: { status: string; reason?: string };
      };
      agentMapIdentity?: { role: string; userId: string };
    };
  };
  expect(created.session.planning.identity).toMatchObject({
    role: "map-planner",
    userId: "local:machine-1",
  });
  expect(created.session.agentMapIdentity).toEqual(
    created.session.planning.identity,
  );
  expect(created.session.planning.greeting).toEqual({
    status: "skipped",
    reason: "user-proceeded",
  });

  const launchOpts = launches[0]!;
  const metadata = launchOpts.agentMapMcp;
  expect(metadata?.url).toBe(`http://127.0.0.1:${server.port}/mcp/agent-map`);
  expect(metadata?.url).not.toContain(":0/");
  const config = JSON.parse(
    await fs.readFile(launchOpts!.mcpConfigFile!, "utf8"),
  );
  expect(config.mcpServers["agent-map"].headers.Authorization).toBe(
    `Bearer ${metadata!.bearerToken}`,
  );
  const systemPrompt = await fs.readFile(launchOpts!.systemPromptFile!, "utf8");
  expect(systemPrompt).toContain(
    "Let the user's first real message be the first visible conversation turn",
  );
  expect(systemPrompt).not.toContain(
    "This is a private Agent Studio control turn",
  );

  const client = new Client({ name: "signed-out-planner-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(metadata!.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${metadata!.bearerToken}` },
    },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map(({ name }) => name).sort()).toEqual([
    "agent_map_propose",
    "agent_map_read",
    "agent_map_validate",
  ]);
  await client.close();

  const ordinary = await server.sessionManager.create({
    cwd: projectRoot,
    harness: "claude-code",
  });
  expect(ordinary.agentMapIdentity).toMatchObject({
    role: "agent-builder",
    userId: "local:machine-1",
    assignment: { kind: "unplanned" },
  });
  const ordinaryLaunch = launches[1]!;
  expect(ordinaryLaunch.agentMapMcp).toBeDefined();
  const ordinaryConfig = JSON.parse(
    await fs.readFile(ordinaryLaunch.mcpConfigFile!, "utf8"),
  );
  expect(ordinaryConfig.mcpServers["agent-map"].headers.Authorization).toBe(
    `Bearer ${ordinaryLaunch.agentMapMcp!.bearerToken}`,
  );
});
