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
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
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

it("creates one ordinary Plan Agents session for a newly opened project and never from a map read", async () => {
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
  expect(launches).toEqual([]);

  const firstOpen = await request("/settings", {
    method: "PATCH",
    body: JSON.stringify({ recentDirs: [freshRoot, projectRoot] }),
  });
  expect(firstOpen.status).toBe(200);
  await vi.waitFor(() => expect(server!.sessionManager.list()).toHaveLength(1));
  expect(launches).toHaveLength(1);
  const [firstSession] = server.sessionManager.list();
  const freshProjectId = firstSession!.agentMapIdentity!.projectId;
  expect(firstSession).toMatchObject({
    title: "Plan Agents",
    cwd: freshRoot,
    agentMapIdentity: {
      projectId: freshProjectId,
      sessionId: firstSession!.id,
      userId: "local:machine-1",
    },
    projectBootstrap: {
      projectId: freshProjectId,
      targetSessionId: firstSession!.id,
      userId: "local:machine-1",
    },
  });
  expect(firstSession).not.toHaveProperty("planning");

  const queuedUserInput = await request(`/sessions/${firstSession!.id}/input`, {
    method: "POST",
    body: JSON.stringify({
      text: "Implement the requested feature directly",
      submit: true,
    }),
  });
  expect(queuedUserInput.status).toBe(200);
  expect(firstSession!.projectBootstrap).toMatchObject({
    bootstrap: { status: "skipped", reason: "user-proceeded" },
    queuedInputIds: [expect.any(String)],
  });

  const repeatedOpen = await request("/settings", {
    method: "PATCH",
    body: JSON.stringify({ recentDirs: [freshRoot, projectRoot] }),
  });
  expect(repeatedOpen.status).toBe(200);
  expect(server.sessionManager.list()).toHaveLength(1);
  expect(launches).toHaveLength(1);

  const mapRead = await request(
    `/projects/${freshProjectId}/agent-map/workspace`,
  );
  expect(mapRead.status).toBe(200);
  expect(server.sessionManager.list()).toHaveLength(1);
  expect(launches).toHaveLength(1);
});

it("does not spawn an automatic duplicate when an explicit first session wins the bootstrap claim", async () => {
  const launches: LaunchOpts[] = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts) => {
      launches.push(opts);
      return { command: "bash", args: [], env: {}, cwd: opts.cwd };
    },
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
  const freshRoot = path.join(root, "explicit-first-project");
  await Promise.all([fs.mkdir(webDir), fs.mkdir(freshRoot)]);
  await fs.writeFile(path.join(webDir, "index.html"), "<html></html>");
  const needed = deferred();
  const releaseAutomaticCreate = deferred();
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
    projectBootstrapTestHooks: {
      afterProjectSessionNeeded: async () => {
        needed.resolve();
        await releaseAutomaticCreate.promise;
      },
    },
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

  const opening = request("/settings", {
    method: "PATCH",
    body: JSON.stringify({ recentDirs: [freshRoot, projectRoot] }),
  });
  await needed.promise;
  const explicitResponse = await request("/sessions", {
    method: "POST",
    body: JSON.stringify({
      cwd: freshRoot,
      harness: "claude-code",
      initialUserInputPending: true,
    }),
  });
  expect(explicitResponse.status).toBe(201);
  const explicit = (await explicitResponse.json()) as {
    id: string;
    title: string;
    projectBootstrap?: { bootstrap: { status: string; reason?: string } };
  };
  releaseAutomaticCreate.resolve();
  expect((await opening).status).toBe(200);

  expect(server.sessionManager.list()).toHaveLength(1);
  expect(server.sessionManager.list()[0]).toMatchObject({
    id: explicit.id,
    title: "Plan Agents",
    projectBootstrap: {
      bootstrap: { status: "skipped", reason: "user-proceeded" },
    },
  });
  expect(explicit.title).toBe("Plan Agents");
  expect(launches).toHaveLength(1);
});

it("automatically seeds one durable map through the real E2 tools without replaying after duplicate readiness or restart", async () => {
  const launches: LaunchOpts[] = [];
  const tokenPathFor = (sessionId: string) =>
    path.join(root, `${sessionId}.ingest.json`);
  const inputPathFor = (sessionId: string) =>
    path.join(root, `${sessionId}.pty-input`);
  const launch = (opts: LaunchOpts): SpawnSpec => {
    launches.push(opts);
    return {
      command: "bash",
      args: [
        "-c",
        'printf \'{"ingestToken":"%s"}\' "$SAPIOM_HARNESS_INGEST_TOKEN" > "$SAPIOM_TEST_INGEST_TOKEN_PATH"; while IFS= read -r line; do printf "%s\\n" "$line" >> "$SAPIOM_TEST_INPUT_PATH"; done',
      ],
      env: {
        SAPIOM_TEST_INGEST_TOKEN_PATH: tokenPathFor(opts.harnessSessionId),
        SAPIOM_TEST_INPUT_PATH: inputPathFor(opts.harnessSessionId),
      },
      cwd: opts.cwd,
    };
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
  const freshRoot = path.join(root, "automatic-bootstrap-project");
  await Promise.all([fs.mkdir(webDir), fs.mkdir(freshRoot)]);
  await fs.writeFile(path.join(webDir, "index.html"), "<html></html>");

  const boot = () =>
    startServer({
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
  const readIngestToken = async (sessionId: string): Promise<string> => {
    let token = "";
    await vi.waitFor(async () => {
      const parsed = JSON.parse(
        await fs.readFile(tokenPathFor(sessionId), "utf8"),
      ) as { ingestToken?: string };
      token = parsed.ingestToken ?? "";
      expect(token).not.toBe("");
    });
    return token;
  };
  const postHook = async (
    sessionId: string,
    token: string,
    hookEvent: "SessionStart" | "UserPromptSubmit" | "Stop",
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${server!.port}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hookEvent, harnessSessionId: sessionId, payload }),
    });
    expect(response.status).toBe(200);
  };
  const capturedInputs = async (sessionId: string): Promise<string[]> => {
    const text = await fs.readFile(inputPathFor(sessionId), "utf8");
    return text.trimEnd().split("\n");
  };
  const connect = async (opts: LaunchOpts): Promise<Client> => {
    const metadata = opts.agentMapMcp!;
    const client = new Client({
      name: "automatic-bootstrap-script",
      version: "1",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(metadata.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${metadata.bearerToken}` },
        },
      }),
    );
    return client;
  };

  server = await boot();
  const opened = await request("/settings", {
    method: "PATCH",
    body: JSON.stringify({ recentDirs: [freshRoot, projectRoot] }),
  });
  expect(opened.status).toBe(200);
  await vi.waitFor(() => expect(server!.sessionManager.list()).toHaveLength(1));
  const [session] = server.sessionManager.list();
  expect(session).toMatchObject({
    cwd: freshRoot,
    title: "Plan Agents",
    projectBootstrap: {
      bootstrap: { status: "pending" },
    },
  });
  const automaticProjectId = session!.agentMapIdentity!.projectId;
  const providerSessionId = "provider-automatic-bootstrap";
  const firstIngestToken = await readIngestToken(session!.id);

  await postHook(session!.id, firstIngestToken, "SessionStart", {
    session_id: providerSessionId,
    source: "startup",
    cwd: freshRoot,
  });
  await postHook(session!.id, firstIngestToken, "SessionStart", {
    session_id: providerSessionId,
    source: "startup",
    cwd: freshRoot,
  });
  let bootstrapPrompt = "";
  await vi.waitFor(async () => {
    const inputs = await capturedInputs(session!.id);
    expect(inputs).toHaveLength(1);
    bootstrapPrompt = inputs[0]!;
    expect(bootstrapPrompt).toContain("Agent Studio project bootstrap");
    expect(bootstrapPrompt).toContain("Read the current Agent Map first");
  });
  await postHook(session!.id, firstIngestToken, "UserPromptSubmit", {
    session_id: providerSessionId,
    prompt: bootstrapPrompt,
  });

  const batch = {
    schemaVersion: 1,
    proposalId: null,
    expectedVersion: 0,
    requestId: "automatic-bootstrap-seed-v1",
    operations: [
      {
        kind: "add-node",
        draftRef: "market-research",
        node: {
          kind: "agent",
          name: "Market Research",
          purpose: "Research the top ten stocks trading today",
          ownerAgent: null,
          contractRefs: ["ResearchReport"],
        },
      },
    ],
  };
  const firstClient = await connect(launches[0]!);
  let firstProposal: Awaited<ReturnType<Client["callTool"]>>;
  try {
    const initial = await firstClient.callTool({
      name: "agent_map_read",
      arguments: {},
    });
    expect(initial.isError).not.toBe(true);
    expect(initial.structuredContent).toMatchObject({ proposal: null });
    const validated = await firstClient.callTool({
      name: "agent_map_validate",
      arguments: batch,
    });
    expect(validated.isError).not.toBe(true);
    expect(validated.structuredContent).toMatchObject({ currentVersion: 0 });
    firstProposal = await firstClient.callTool({
      name: "agent_map_propose",
      arguments: batch,
    });
    expect(firstProposal.isError).not.toBe(true);
    expect(firstProposal.structuredContent).toMatchObject({ version: 1 });
  } finally {
    await firstClient.close();
  }

  await postHook(session!.id, firstIngestToken, "Stop", {
    session_id: providerSessionId,
    last_assistant_message: "Seeded the evidence-supported initial Agent Map.",
  });
  await postHook(session!.id, firstIngestToken, "Stop", {
    session_id: providerSessionId,
    last_assistant_message: "Duplicate lifecycle signal.",
  });
  await vi.waitFor(() => {
    expect(
      server!.sessionManager.get(session!.id)?.projectBootstrap,
    ).toMatchObject({ bootstrap: { status: "delivered" } });
  });

  const durableFile = path.join(
    root,
    "agent-map",
    "projects",
    automaticProjectId,
    "workspace.json",
  );
  const durableBeforeRestart = JSON.parse(
    await fs.readFile(durableFile, "utf8"),
  ) as {
    storageSchemaVersion: number;
    proposal: { version: number; nodes: unknown[]; history: unknown[] };
    receipts: unknown[];
  };
  expect(durableBeforeRestart.storageSchemaVersion).toBe(1);
  expect(durableBeforeRestart.proposal).toMatchObject({
    version: 1,
    nodes: [expect.any(Object)],
  });
  expect(durableBeforeRestart.proposal.history).toHaveLength(1);
  expect(durableBeforeRestart.receipts).toHaveLength(1);
  expect(await capturedInputs(session!.id)).toHaveLength(1);

  await server.close();
  server = undefined;
  server = await boot();
  expect(launches).toHaveLength(1);
  expect(server.sessionManager.get(session!.id)).toMatchObject({
    id: session!.id,
    agentSessionId: providerSessionId,
    status: "exited",
    projectBootstrap: { bootstrap: { status: "delivered" } },
  });

  await fs.rm(tokenPathFor(session!.id), { force: true });
  await server.sessionManager.resume(session!.id);
  expect(launches).toHaveLength(2);
  const resumedIngestToken = await readIngestToken(session!.id);
  expect(resumedIngestToken).not.toBe(firstIngestToken);
  await postHook(session!.id, resumedIngestToken, "SessionStart", {
    session_id: providerSessionId,
    source: "resume",
    cwd: freshRoot,
  });
  await postHook(session!.id, resumedIngestToken, "SessionStart", {
    session_id: providerSessionId,
    source: "resume",
    cwd: freshRoot,
  });
  await vi.waitFor(() => {
    expect(server!.sessionManager.get(session!.id)?.ready).toBe(true);
  });

  const resumedClient = await connect(launches[1]!);
  try {
    const restored = await resumedClient.callTool({
      name: "agent_map_read",
      arguments: {},
    });
    expect(restored.structuredContent).toMatchObject({
      proposal: {
        version: 1,
        nodes: [expect.objectContaining({ name: "Market Research" })],
        history: [expect.objectContaining({ requestId: batch.requestId })],
      },
    });
    const replayed = await resumedClient.callTool({
      name: "agent_map_propose",
      arguments: batch,
    });
    expect(replayed.structuredContent).toEqual(
      firstProposal!.structuredContent,
    );
  } finally {
    await resumedClient.close();
  }
  expect(await capturedInputs(session!.id)).toHaveLength(1);
  const durableAfterRestart = JSON.parse(
    await fs.readFile(durableFile, "utf8"),
  ) as {
    proposal: { version: number; nodes: unknown[]; history: unknown[] };
    receipts: unknown[];
  };
  expect(durableAfterRestart.proposal).toMatchObject({ version: 1 });
  expect(durableAfterRestart.proposal.nodes).toHaveLength(1);
  expect(durableAfterRestart.proposal.history).toHaveLength(1);
  expect(durableAfterRestart.receipts).toHaveLength(1);
});

it("initializes every newly opened root once when one settings update creates multiple projects", async () => {
  const launches: LaunchOpts[] = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts) => {
      launches.push(opts);
      return { command: "bash", args: [], env: {}, cwd: opts.cwd };
    },
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
  const firstRoot = path.join(root, "first-project");
  const secondRoot = path.join(root, "second-project");
  await Promise.all([
    fs.mkdir(webDir),
    fs.mkdir(firstRoot),
    fs.mkdir(secondRoot),
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

  const response = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-harness-token": "boot-token",
    },
    body: JSON.stringify({
      recentDirs: [firstRoot, secondRoot, projectRoot],
    }),
  });

  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(server!.sessionManager.list()).toHaveLength(2));
  const sessions = server.sessionManager.list();
  expect(sessions).toHaveLength(2);
  expect(
    sessions
      .map((session) => ({
        cwd: session.cwd,
        title: session.title,
        projectId: session.agentMapIdentity?.projectId,
      }))
      .sort((left, right) => left.cwd.localeCompare(right.cwd)),
  ).toEqual([
    { cwd: firstRoot, title: "Plan Agents", projectId: expect.any(String) },
    { cwd: secondRoot, title: "Plan Agents", projectId: expect.any(String) },
  ]);
  expect(
    new Set(sessions.map((session) => session.agentMapIdentity?.projectId))
      .size,
  ).toBe(2);
  expect(launches).toHaveLength(2);

  const repeated = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-harness-token": "boot-token",
    },
    body: JSON.stringify({
      recentDirs: [firstRoot, secondRoot, projectRoot],
    }),
  });
  expect(repeated.status).toBe(200);
  expect(server.sessionManager.list()).toHaveLength(2);
  expect(launches).toHaveLength(2);
});

it("recovers a durable scheduled project intent at server boot", async () => {
  const nestedRoot = path.join(projectRoot, "nested-binding");
  await fs.mkdir(nestedRoot);
  const catalog = new StudioProjectCatalog(
    path.join(root, "studio-projects.json"),
  );
  const identity = await catalog.resolveIdentity(projectId);
  await catalog.moveRootBinding(
    projectId,
    identity!.rootBindings[0]!.id,
    nestedRoot,
  );
  // Keep the narrower binding first in persisted array order. Recovery must
  // still choose the canonical outermost root rather than UUID/array order.
  await catalog.addRootBinding(projectId, projectRoot);
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({ recentDirs: [nestedRoot, projectRoot] }),
  );
  const intentDirectory = path.join(
    root,
    "agent-map",
    "project-bootstrap",
    "projects",
  );
  await fs.mkdir(intentDirectory, { recursive: true });
  await fs.writeFile(
    path.join(intentDirectory, `${projectId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      projectId,
      userId: "local:machine-1",
      targetSessionId: null,
      status: "scheduled",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    })}\n`,
  );
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
    loadSystemPrompt: async () => "ordinary coding prompt",
  });

  // Default auto-create is intentionally enabled. Give its detached create
  // path enough time to expose a duplicate if recovery failed to suppress it.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  expect(launches).toHaveLength(1);
  expect(server.sessionManager.list()).toEqual([
    expect.objectContaining({
      title: "Plan Agents",
      cwd: projectRoot,
      agentMapIdentity: expect.objectContaining({ projectId }),
      projectBootstrap: expect.objectContaining({
        projectId,
        userId: "local:machine-1",
      }),
    }),
  ]);
  const recovered = JSON.parse(
    await fs.readFile(path.join(intentDirectory, `${projectId}.json`), "utf8"),
  ) as { status: string; targetSessionId: string | null };
  expect(recovered).toEqual(
    expect.objectContaining({
      status: "claimed",
      targetSessionId: server.sessionManager.list()[0]!.id,
    }),
  );
});
