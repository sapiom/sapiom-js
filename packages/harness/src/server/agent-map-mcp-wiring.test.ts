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
import { PROJECT_AGENT_PROMPT_APPENDIX } from "../profiles/project-agent.js";
import { StudioProjectCatalog } from "@sapiom/agent-map/node/studio-project-catalog";
import { startServer, type HarnessServer } from "./index.js";

let root: string;
let projectRoot: string;
let projectId: string;
let server: HarnessServer | undefined;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
  vi.restoreAllMocks();
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

  const hostResponse = await fetch(`${metadata!.url}/host-context`, {
    headers: { Authorization: `Bearer ${metadata!.bearerToken}` },
  });
  expect(hostResponse.status).toBe(200);
  expect(await hostResponse.json()).toEqual({
    protocolVersion: 1, host: "sapiom-studio", stateRoot: root,
    projectId, sessionId: session.id, userId: "user-1", generation: 1,
    capabilities: ["session-context"],
  });

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
    "build_plan_apply",
    "build_plan_brief_refresh",
    "build_plan_read",
    "build_plan_rebase",
    "build_plan_validate",
    "project_subsession_delegate",
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
  const stopReadyBridge = server.sessionManager.onStatusChange(
    (candidate, context) => {
      if (
        candidate.id !== session.id &&
        candidate.status === "running" &&
        !candidate.ready &&
        context.runtimeEpoch
      ) {
        server!.sessionManager.setReady(candidate.id, context.runtimeEpoch);
      }
    },
  );
  const delegationArguments = {
    schemaVersion: 1,
    requestKey: "wiring-delegation",
    operation: {
      kind: "delegate",
      delegations: [{
        delegationKey: "child",
        outcome: "Implement the focused child task",
      }],
    },
  };
  const delegated = await client.callTool({
    name: "project_subsession_delegate",
    arguments: delegationArguments,
  });
  const childMcp = launchOpts?.agentMapMcp;
  expect(childMcp).toBeDefined();
  const childClient = new Client({ name: "nested-delegation-test", version: "1" });
  await childClient.connect(new StreamableHTTPClientTransport(new URL(childMcp!.url), {
    requestInit: { headers: { Authorization: `Bearer ${childMcp!.bearerToken}` } },
  }));
  expect((await childClient.listTools()).tools.map(({ name }) => name)).toContain(
    "project_subsession_delegate",
  );
  const nested = await childClient.callTool({
    name: "project_subsession_delegate",
    arguments: {
      schemaVersion: 1,
      requestKey: "nested-request",
      operation: {
        kind: "delegate",
        delegations: [{
          delegationKey: "grandchild",
          outcome: "Implement the nested task",
        }],
      },
    },
  });
  expect(nested.structuredContent).toMatchObject({
    results: [{ outcome: "created", sessionState: "ready" }],
  });
  await childClient.close();
  const retried = await client.callTool({
    name: "project_subsession_delegate",
    arguments: delegationArguments,
  });
  const released = await client.callTool({
    name: "project_subsession_delegate",
    arguments: {
      schemaVersion: 1,
      requestKey: "release-child",
      operation: { kind: "release", delegationKeys: ["child"] },
    },
  });
  stopReadyBridge();
  expect(delegated.isError).not.toBe(true);
  expect(delegated.structuredContent).toMatchObject({
    requestKey: "wiring-delegation",
    results: [{ outcome: "created", sessionState: "ready" }],
  });
  expect(retried.structuredContent).toMatchObject({
    replayed: true,
    results: [{
      outcome: "reused",
      sessionId: (delegated.structuredContent as { results: Array<{ sessionId: string }> }).results[0]!.sessionId,
    }],
  });
  expect(released.structuredContent).toMatchObject({
    results: [{ outcome: "released", sessionState: "closed" }],
  });
  expect(server.sessionManager.isLive(
    (delegated.structuredContent as { results: Array<{ sessionId: string }> })
      .results[0]!.sessionId,
  )).toBe(false);
  expect(server.sessionManager.getSubsessionBinding(
    (delegated.structuredContent as { results: Array<{ sessionId: string }> })
      .results[0]!.sessionId,
  )).toBeNull();
  expect(server.sessionManager.list().filter(({ id }) =>
    id === (nested.structuredContent as { results: Array<{ sessionId: string }> })
      .results[0]!.sessionId,
  )).toHaveLength(1);
  expect(server.sessionManager.list()).toHaveLength(3);
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
  expect((await fetch(`${metadata!.url}/host-context`, {
    headers: { Authorization: `Bearer ${metadata!.bearerToken}` },
  })).status).toBe(401);
});

it("keeps an evicted descendant session resumable in its durable canonical project after restart", async () => {
  const adapter: HarnessAdapter = {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts) => ({ command: "bash", args: [], env: {}, cwd: opts.cwd }),
    resume: (_id, opts) => ({
      command: "bash",
      args: [],
      env: {},
      cwd: opts.cwd,
    }),
    listPastSessions: async () => [],
    canResume: async () => true,
  };
  const webDir = path.join(root, "web");
  const descendant = path.join(projectRoot, "packages", "worker");
  await Promise.all([
    fs.mkdir(webDir),
    fs.mkdir(descendant, { recursive: true }),
  ]);
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
    loadSystemPrompt: async () => "ordinary coding prompt",
  });

  const created = await server.sessionManager.create({
    cwd: descendant,
    harness: "claude-code",
  });
  expect(created).toMatchObject({
    cwd: descendant,
    title: "worker",
    agentMapIdentity: {
      projectId,
      sessionId: created.id,
      userId: "local:machine-1",
    },
  });

  const repeatedOpen = await fetch(
    `http://127.0.0.1:${server.port}/api/settings`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-harness-token": "boot-token",
      },
      body: JSON.stringify({ recentDirs: [projectRoot] }),
    },
  );
  expect(repeatedOpen.status).toBe(200);
  expect(server.sessionManager.list()).toHaveLength(1);
  const catalog = new StudioProjectCatalog(
    path.join(root, "studio-projects.json"),
  );
  expect(await catalog.list()).toHaveLength(1);
  await expect(
    catalog.resolveIdentityForPath(descendant),
  ).resolves.toMatchObject({ projectId });

  await server.sessionManager.setAgentSessionId(
    created.id,
    "provider-descendant-session",
  );
  await server.sessionManager.kill(created.id);
  const evicted = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-harness-token": "boot-token",
    },
    body: JSON.stringify({ recentDirs: [] }),
  });
  expect(evicted.status).toBe(200);
  const reconciledState = await fetch(
    `http://127.0.0.1:${server.port}/api/state`,
    { headers: { "x-harness-token": "boot-token" } },
  );
  expect(reconciledState.status).toBe(200);
  await server.close();
  server = undefined;

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
    loadSystemPrompt: async () => "ordinary coding prompt",
  });
  const restartedCatalog = new StudioProjectCatalog(
    path.join(root, "studio-projects.json"),
  );
  await expect(
    restartedCatalog.resolveIdentityForPath(descendant),
  ).resolves.toMatchObject({ projectId });
  await expect(
    restartedCatalog.resolveIdentity(projectId),
  ).resolves.toMatchObject({
    rootBindings: [expect.objectContaining({ status: "active" })],
  });
  const resumed = await server.sessionManager.resume(created.id);
  expect(resumed).toMatchObject({
    id: created.id,
    agentSessionId: "provider-descendant-session",
    status: "running",
    agentMapIdentity: { projectId },
  });
  const beforeFailure = await restartedCatalog.list();
  const sessionsBeforeFailure = server.sessionManager.list();
  const reconcile = vi.spyOn(StudioProjectCatalog.prototype, "reconcile");
  vi.spyOn(StudioProjectCatalog.prototype, "lookupIdentityForPath")
    .mockResolvedValue({ kind: "unavailable" });
  await expect(server.sessionManager.create({
    cwd: descendant, harness: "claude-code",
  })).rejects.toMatchObject({ code: "storage_unavailable" });
  expect(reconcile).not.toHaveBeenCalled();
  expect(await restartedCatalog.list()).toEqual(beforeFailure);
  expect(server.sessionManager.list()).toEqual(sessionsBeforeFailure);
});

it("gives every signed-out project session the same coding prompt and Agent Map tools", async () => {
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

  const created = await server.sessionManager.create({
    cwd: projectRoot,
    harness: "claude-code",
  });
  expect(created.agentMapIdentity).toEqual({
    projectId,
    sessionId: created.id,
    userId: "local:machine-1",
  });
  const host = await fetch(`${launches[0]!.agentMapMcp!.url}/host-context`, {
    headers: { Authorization: `Bearer ${launches[0]!.agentMapMcp!.bearerToken}` },
  });
  expect(host.status).toBe(200);
  expect(await host.json()).toMatchObject({
    ...created.agentMapIdentity, stateRoot: root, generation: 1,
  });
  expect(created.projectBootstrap).toBeUndefined();

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
  expect(systemPrompt).toContain(codingPrompt);
  expect(systemPrompt).toContain(PROJECT_AGENT_PROMPT_APPENDIX);
  expect(systemPrompt).toContain("plan and implement in the same session");
  expect(systemPrompt).toContain("Proceed directly");
  expect(systemPrompt).not.toMatch(/map[-]planner/u);
  expect(systemPrompt).not.toContain("not to implement it yet");
  expect(systemPrompt).not.toContain("stop before implementation");
  expect(systemPrompt).not.toContain(
    "This is a private Agent Studio control turn",
  );
  expect(loadSystemPrompt).toHaveBeenCalledTimes(1);
  const compatibilityEmitter = await fs.readFile(
    path.join(path.dirname(launchOpts.settingsFile!), "emit.cjs"),
    "utf8",
  );
  expect(compatibilityEmitter).toContain(
    "const sessionStartSystemMessage = null;",
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
    "build_plan_apply",
    "build_plan_brief_refresh",
    "build_plan_read",
    "build_plan_rebase",
    "build_plan_validate",
    "project_subsession_delegate",
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
  expect(ordinary.agentMapIdentity).toEqual({
    projectId,
    sessionId: ordinary.id,
    userId: "local:machine-1",
  });
  const ordinaryLaunch = launches[1]!;
  expect(ordinaryLaunch.agentMapMcp).toBeDefined();
  const ordinaryPrompt = await fs.readFile(
    ordinaryLaunch.systemPromptFile!,
    "utf8",
  );
  expect(ordinaryPrompt).toBe(systemPrompt);
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

it("opening a new project mints it and starts no session (flow-creation.md Q5)", async () => {
  // The user types first. A newly durable project used to get an automatic
  // "Plan Agents" session (#824 to #826, #834); under the agreed flow, New
  // project and Add project open the folder as a project and nothing follows.
  // The project must still exist in the catalog before the client re-reads
  // state, or the new-agent screen has nothing to scope to.
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
    loadSystemPrompt: async () => "ordinary coding prompt",
  });
  const request = (pathname: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${server!.port}/api${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-harness-token": "boot-token",
        ...init?.headers,
      },
    });
  const freshRoot = path.join(root, "fresh-project");
  await fs.mkdir(freshRoot);
  expect(server.sessionManager.list()).toEqual([]);

  const opened = await request("/settings", {
    method: "PATCH",
    body: JSON.stringify({ recentDirs: [freshRoot, projectRoot] }),
  });
  expect(opened.status).toBe(200);

  // The project is minted (the screen can scope to it) ...
  await vi.waitFor(async () => {
    const visibleState = await request("/state");
    expect(visibleState.status).toBe(200);
    const state = await visibleState.json();
    const scope = state.workspaceScopes.find(
      (candidate: { cwd: string }) => candidate.cwd === freshRoot,
    );
    expect(scope?.projectId).toEqual(expect.any(String));
    expect(
      state.studioProjects.some(
        (project: { projectId: string }) => project.projectId === scope.projectId,
      ),
    ).toBe(true);
  });
  // ... and nothing was started for it, then or later.
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(server.sessionManager.list()).toEqual([]);
  expect(launches).toEqual([]);
  const state = await (await request("/state")).json();
  expect(state.sessions).toEqual([]);

  // A session the USER opens in the project is an ordinary one: no bootstrap
  // metadata, no "Plan Agents" title, the ordinary system prompt.
  const created = await request("/sessions", {
    method: "POST",
    body: JSON.stringify({
      cwd: freshRoot,
      harness: "claude-code",
      initialPrompt: "Build a ticket triage agent.",
    }),
  });
  expect(created.status).toBe(201);
  const [session] = server.sessionManager.list();
  expect(session).toMatchObject({ cwd: freshRoot, title: expect.any(String) });
  expect(session!.title).not.toBe("Plan Agents");
  expect(session).not.toHaveProperty("projectBootstrap");
  expect(launches).toHaveLength(1);
  expect(launches[0]?.initialPrompt).toBe("Build a ticket triage agent.");
});

it.each([false, true])("retains a first project's scope during preparation and refresh (fresh catalog: %s)", async (fresh) => {
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ recentDirs: [] }));
  if (fresh) {
    await fs.writeFile(path.join(root, "studio-projects.json"), JSON.stringify({ schemaVersion: 1, projects: [] }));
  }
  const preparing = deferred();
  const release = deferred();
  const launch = vi.fn((opts: LaunchOpts): SpawnSpec => ({ command: "bash", args: [], env: {}, cwd: opts.cwd }));
  const adapter: HarnessAdapter = {
    id: "claude-code", eventSource: "hooks", doctor: async () => [], launch,
    resume: (_id, opts) => launch(opts), listPastSessions: async () => [], canResume: async () => true,
  };
  const cwd = path.join(projectRoot, "new-project");
  server = await startServer({
    port: 0, bootToken: "boot-token", telemetryOptIn: false, authMode: "disabled",
    adapters: { "claude-code": adapter }, stateRoot: root, launchDir: projectRoot,
    autoCreateSession: false,
    buildLaunchOpts: async (_id, req) => {
      await fs.mkdir(req.cwd, { recursive: true });
      preparing.resolve();
      await release.promise;
      return {};
    },
  });
  const headers = { "content-type": "application/json", "x-harness-token": "boot-token" };
  const creating = fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
    method: "POST", headers, body: JSON.stringify({ cwd, harness: "claude-code", initialPrompt: "Build ticket triage." }),
  });
  await preparing.promise;
  try {
    const state = await (await fetch(`http://127.0.0.1:${server.port}/api/state`, {
      headers, signal: AbortSignal.timeout(2000),
    })).json();
    expect(launch).not.toHaveBeenCalled();
    expect(state.sessions).toHaveLength(0);
  } finally {
    release.resolve();
  }
  const response = await creating;
  expect(response.status).toBe(201);
  expect(launch).toHaveBeenCalledOnce();
  expect(server.sessionManager.list()).toHaveLength(1);
  expect(server.sessionManager.listPendingCreates()).toEqual([]);
});

