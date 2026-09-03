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
import { AGENT_MAP_PLANNER_SESSION_START_MESSAGE } from "../profiles/agent-map-planner.js";
import { AGENT_MAP_BUILDER_SECONDARY_PLANNING_SYSTEM_PROMPT } from "../profiles/agent-map-builder-planning.js";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import { computeArchitectureGraphDigest } from "../core/build-plan-canonicalization.js";
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

it("withholds Agent Map transport and mutation instructions from a secondary builder", async () => {
  let launchOpts: LaunchOpts | undefined;
  const adapter: HarnessAdapter = {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts) => {
      launchOpts = opts;
      return { command: "bash", args: [], env: {}, cwd: opts.cwd };
    },
    resume: (_id, opts) => {
      launchOpts = opts;
      return { command: "bash", args: [], env: {}, cwd: opts.cwd };
    },
    listPastSessions: async () => [],
    canResume: async () => true,
  };
  const webDir = path.join(root, "web-secondary");
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
    loadSystemPrompt: async () => "ordinary prompt",
  });
  const metadata = {
    bindingId: "builder-binding_00000000-0000-7000-8000-000000000001",
    lifecycleEpoch: 1,
    purpose: "implementation-planning",
    assignmentId: "assignment_00000000-0000-7000-8000-000000000001",
    plannedAgentId: "node_00000000-0000-7000-8000-000000000001",
    source: {
      kind: "proposal",
      proposalId: "proposal_00000000-0000-7000-8000-000000000001",
      version: 1,
      graphDigest: `sha256:${"1".repeat(64)}`,
    },
    plan: {
      planId: "build-plan_00000000-0000-7000-8000-000000000001",
      version: 1,
      semanticDigest: `sha256:${"2".repeat(64)}`,
    },
    brief: {
      briefId: "brief_00000000-0000-7000-8000-000000000001",
      version: 1,
      semanticDigest: `sha256:${"3".repeat(64)}`,
    },
    bootstrapDigest: `sha256:${"4".repeat(64)}`,
    state: "planning",
    primary: false,
  } as const;
  const session = await server.sessionManager.create(
    { cwd: projectRoot, harness: "claude-code" },
    {
      executionPolicy: "planning-readonly",
      agentMapCapability: false,
      agentMapIdentity: (sessionId) => ({
        projectId: projectId as never,
        sessionId,
        userId: "user-1",
        role: "agent-builder",
        assignment: {
          kind: "planned",
          agentId: metadata.plannedAgentId as never,
        },
      }),
      builderPlanning: () => metadata as never,
      promptAppendix: () => "<builder-assignment-data />",
    },
  );

  expect(session.builderPlanning?.primary).toBe(false);
  expect(launchOpts?.agentMapMcp).toBeUndefined();
  const config = JSON.parse(
    await fs.readFile(launchOpts!.mcpConfigFile!, "utf8"),
  );
  expect(config.mcpServers).not.toHaveProperty("agent-map");
  const prompt = await fs.readFile(launchOpts!.systemPromptFile!, "utf8");
  expect(prompt).toContain(AGENT_MAP_BUILDER_SECONDARY_PLANNING_SYSTEM_PROMPT);
  expect(prompt).not.toContain("agent_map_propose");
  expect(prompt).not.toContain("planning_result_submit");
});

it("gives a signed-out local planner its scoped Agent Map tools", async () => {
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
  expect(systemPrompt).toContain("<agent-map-planner-context>");
  expect(systemPrompt).toContain(
    "Do not act as a coding or implementation agent",
  );
  expect(systemPrompt).toContain(
    "Let the user's first real message be the first visible conversation turn",
  );
  expect(systemPrompt).toContain("revision_source_unavailable");
  expect(systemPrompt).toContain("do not retry it");
  const normalizedSystemPrompt = systemPrompt.replace(/\s+/gu, " ");
  expect(normalizedSystemPrompt).toContain(
    "build_plan_prepare_planning_sessions",
  );
  expect(normalizedSystemPrompt).toContain(
    "Summarize every top-level agent session",
  );
  expect(normalizedSystemPrompt).toContain("Stop and wait for their reply");
  expect(normalizedSystemPrompt).toContain(
    "Do not imply that a Studio button is required",
  );
  expect(normalizedSystemPrompt).toContain("E5 remains the separate gate");
  expect(systemPrompt).not.toContain("In your first response, briefly explain");
  expect(systemPrompt).not.toContain(codingPrompt);
  expect(systemPrompt).not.toContain("You are the coding agent");
  expect(systemPrompt).not.toContain(
    "This is a private Agent Studio control turn",
  );
  expect(loadSystemPrompt).not.toHaveBeenCalled();
  expect(AGENT_MAP_PLANNER_SESSION_START_MESSAGE).toBe(
    [
      "Agent Map planning session",
      "Use this session to scope what you want to build—not to implement it yet. Build-plan reads, validation, application, deterministic brief compilation, and targeted impact evaluation are available for exact proposal sources. Confirmed-revision operations remain unavailable until the persisted revision reader is installed. Start by describing the outcome you want.",
    ].join("\n"),
  );
  const plannerEmitter = await fs.readFile(
    path.join(path.dirname(launchOpts.settingsFile!), "emit.cjs"),
    "utf8",
  );
  expect(plannerEmitter).toContain(
    `const sessionStartSystemMessage = ${JSON.stringify(AGENT_MAP_PLANNER_SESSION_START_MESSAGE)};`,
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
    "build_plan_open_planning_sessions",
    "build_plan_prepare_planning_sessions",
    "build_plan_read",
    "build_plan_rebase",
    "build_plan_validate",
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
    const snapshot = await client.callTool({
      name: "agent_map_read",
      arguments: {},
    });
    const proposal = (
      snapshot.structuredContent as {
        proposal: {
          id: string;
          version: number;
          nodes: Array<{ id: string }>;
          relationships: unknown[];
        };
      }
    ).proposal;
    const graphDigest = computeArchitectureGraphDigest({
      nodes: proposal.nodes,
      relationships: proposal.relationships,
    } as never);
    const unavailableRevision = await client.callTool({
      name: "build_plan_validate",
      arguments: {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: {
          kind: "revision",
          revisionId: "revision_00000000-0000-7000-8000-000000000020",
          revisionNumber: 1,
          graphDigest,
        },
        operations: [
          {
            op: "set-project-outcome",
            outcome: { summary: "Production must resolve this revision" },
          },
        ],
      },
    });
    expect(unavailableRevision).toMatchObject({
      isError: true,
      structuredContent: {
        code: "revision_source_unavailable",
        recovery: "dependency_required",
      },
    });
    const productionAuthoring = await client.callTool({
      name: "build_plan_apply",
      arguments: {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: {
          kind: "proposal",
          proposalId: proposal.id,
          version: proposal.version,
          graphDigest,
        },
        requestId: "request-production-boundary",
        operations: [
          {
            op: "set-project-outcome",
            outcome: { summary: "Production must compile this plan" },
          },
          {
            op: "create-agent-assignment",
            assignment: {
              plannedAgentId: proposal.nodes[0]!.id,
              mission: "Compile a production focused brief",
              scope: { inScope: ["Core implementation"], nonGoals: ["Deploy"] },
              deliverables: [
                {
                  clientRef: "production-deliverable",
                  description: "A verified implementation plan",
                  artifactNodeIds: [],
                  acceptanceCriterionRefs: [
                    { clientRef: "production-criterion" },
                  ],
                },
              ],
              constraints: [],
              acceptanceCriteria: [
                {
                  clientRef: "production-criterion",
                  ordinal: 1,
                  description: "The focused brief is complete",
                  verification: "Read the persisted brief",
                },
              ],
              milestoneRefs: [],
              unresolvedDecisions: [],
            },
          },
        ],
      },
    });
    expect(productionAuthoring.isError).not.toBe(true);
    expect(productionAuthoring).toMatchObject({
      structuredContent: {
        plan: { version: 1 },
        briefChanges: [
          { plannedAgentId: proposal.nodes[0]!.id, change: "created" },
        ],
      },
    });
    const createdPlan = (
      productionAuthoring.structuredContent as {
        plan: { planId: string; version: number };
      }
    ).plan;
    const unchangedAuthoring = await client.callTool({
      name: "build_plan_apply",
      arguments: {
        schemaVersion: 1,
        planId: createdPlan.planId,
        expectedPlanVersion: createdPlan.version,
        expectedSource: {
          kind: "proposal",
          proposalId: proposal.id,
          version: proposal.version,
          graphDigest,
        },
        requestId: "request-production-unchanged",
        operations: [
          {
            op: "set-project-outcome",
            outcome: { summary: "Production must compile this plan" },
          },
        ],
      },
    });
    expect(unchangedAuthoring.isError).not.toBe(true);
    expect(unchangedAuthoring).toMatchObject({
      structuredContent: {
        plan: { version: 2 },
        briefChanges: [
          { plannedAgentId: proposal.nodes[0]!.id, change: "preserved" },
        ],
      },
    });
  } finally {
    events.close();
    await client.close();
  }
  const refreshedPlanner = await fetch(
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
  expect(refreshedPlanner.status).toBe(201);
  const refreshedPrompt = await fs.readFile(
    launches[1]!.systemPromptFile!,
    "utf8",
  );
  expect(refreshedPrompt).toContain('"architectureSource":{"kind":"proposal"');
  expect(refreshedPrompt).toContain('"version":2');
  expect(refreshedPrompt).toContain('"status":"complete"');
  expect(refreshedPrompt).toContain('"briefCount":1');
  expect(refreshedPrompt).toContain('"staleBriefCount":0');
  expect(refreshedPrompt).not.toContain('"architectureSource":null');

  const ordinary = await server.sessionManager.create({
    cwd: projectRoot,
    harness: "claude-code",
  });
  expect(ordinary.agentMapIdentity).toMatchObject({
    role: "agent-builder",
    userId: "local:machine-1",
    assignment: { kind: "unplanned" },
  });
  const ordinaryLaunch = launches[2]!;
  expect(ordinaryLaunch.agentMapMcp).toBeDefined();
  expect(await fs.readFile(ordinaryLaunch.systemPromptFile!, "utf8")).toBe(
    codingPrompt,
  );
  const ordinaryEmitter = await fs.readFile(
    path.join(path.dirname(ordinaryLaunch.settingsFile!), "emit.cjs"),
    "utf8",
  );
  expect(ordinaryEmitter).toContain("const sessionStartSystemMessage = null;");
  expect(ordinaryEmitter).not.toContain(
    JSON.stringify(AGENT_MAP_PLANNER_SESSION_START_MESSAGE),
  );
  expect(loadSystemPrompt).toHaveBeenCalledOnce();
  const ordinaryConfig = JSON.parse(
    await fs.readFile(ordinaryLaunch.mcpConfigFile!, "utf8"),
  );
  expect(ordinaryConfig.mcpServers["agent-map"].headers.Authorization).toBe(
    `Bearer ${ordinaryLaunch.agentMapMcp!.bearerToken}`,
  );
});
