import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";

import type {
  BusMessage,
  HarnessAdapter,
  LaunchOpts,
  SpawnSpec,
} from "../shared/types.js";
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
  expect(metadata?.url).toBe(`http://127.0.0.1:${server.port}/mcp/agent-map`);
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

it("gives a signed-out ordinary project session its scoped Agent Map tools", async () => {
  const codingPrompt =
    "You are the coding agent running in Agent Studio. Follow the scaffold, run, and deploy authoring loop.";
  const loadSystemPrompt = vi.fn(async () => codingPrompt);
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
    loadSystemPrompt,
  });

  // SAP-3143: the planner route is gone. A project session is the ordinary
  // POST /api/sessions with the project root as cwd, and it gets the map tools.
  const removed = await fetch(
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
  expect(removed.status).toBe(410);
  expect(await removed.json()).toMatchObject({
    code: "planner_sessions_removed",
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": "boot-token",
    },
    body: JSON.stringify({ cwd: projectRoot, harness: "claude-code" }),
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as {
    id: string;
    agentMapIdentity?: { role: string; userId: string; assignment?: unknown };
    planning?: unknown;
  };
  expect(created.agentMapIdentity).toMatchObject({
    role: "agent-builder",
    userId: "local:machine-1",
    assignment: { kind: "unplanned" },
  });
  expect(created.planning).toBeUndefined();

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
  // The ordinary served prompt, untouched: no planner profile, no planner
  // context, no prohibition, no SessionStart planner orientation.
  const systemPrompt = await fs.readFile(launchOpts!.systemPromptFile!, "utf8");
  expect(systemPrompt).toBe(codingPrompt);
  expect(systemPrompt).not.toContain("planner");
  expect(systemPrompt).not.toContain("Do not act as a coding");
  const emitter = await fs.readFile(
    path.join(path.dirname(launchOpts.settingsFile!), "emit.cjs"),
    "utf8",
  );
  expect(emitter).toContain("const sessionStartSystemMessage = null;");
  expect(loadSystemPrompt).toHaveBeenCalledOnce();

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

  const proposalEvents: BusMessage[] = [];
  const events = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws/events?token=boot-token`,
  );
  await new Promise<void>((resolve, reject) => {
    events.once("open", () => resolve());
    events.once("error", reject);
  });
  events.on("message", (data) => {
    try {
      proposalEvents.push(JSON.parse(data.toString()) as BusMessage);
    } catch {
      // The production browser also ignores malformed event frames.
    }
  });
  try {
    const proposed = await client.callTool({
      name: "agent_map_propose",
      arguments: {
        schemaVersion: 1,
        requestId: "request-live-proposal-1",
        proposalId: null,
        expectedVersion: 0,
        operations: [
          {
            kind: "add-node",
            draftRef: "worker",
            node: {
              kind: "agent",
              name: "Worker",
              purpose: "Own the planned work",
              ownerAgent: null,
              contractRefs: [],
            },
          },
        ],
      },
    });
    expect(proposed.isError).not.toBe(true);
    await vi.waitFor(
      () => {
        expect(proposalEvents).toContainEqual({
          type: "agent-map.proposal.changed",
          delta: expect.objectContaining({
            projectId,
            version: 1,
          }),
        });
      },
      { timeout: 1_000 },
    );
  } finally {
    events.close();
    await client.close();
  }
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
  expect(await fs.readFile(ordinaryLaunch.systemPromptFile!, "utf8")).toBe(
    codingPrompt,
  );
  const ordinaryEmitter = await fs.readFile(
    path.join(path.dirname(ordinaryLaunch.settingsFile!), "emit.cjs"),
    "utf8",
  );
  expect(ordinaryEmitter).toContain("const sessionStartSystemMessage = null;");
  expect(loadSystemPrompt).toHaveBeenCalledTimes(2);
  const ordinaryConfig = JSON.parse(
    await fs.readFile(ordinaryLaunch.mcpConfigFile!, "utf8"),
  );
  expect(ordinaryConfig.mcpServers["agent-map"].headers.Authorization).toBe(
    `Bearer ${ordinaryLaunch.agentMapMcp!.bearerToken}`,
  );
});
