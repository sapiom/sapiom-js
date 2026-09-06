import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ProjectAgentSession } from "../shared/agent-map.js";
import { AgentMapAggregateError } from "../core/agent-map-aggregate-migration.js";
import { AgentMapCapabilityRegistry } from "../core/agent-map-capability-registry.js";
import { AgentMapProposalService, AgentMapProposalQuotaError } from "../core/agent-map-proposal-service.js";
import { AgentMapWorkspaceStore, AgentMapWorkspaceStoreError, AgentBriefAppendQuotaError } from "../core/agent-map-workspace-store.js";
import { BuildPlanService } from "../core/build-plan-service.js";
import { BuildPlanStore } from "../core/build-plan-store.js";
import {
  createAgentMapMcpRouter,
  type AgentMapMcpRouterOptions,
} from "./agent-map-mcp.js";
import {
  AgentMapMcpProjectUnavailableError,
  createAgentMapToolServer,
} from "./agent-map-mcp-tools.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const clients: Client[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(
    clients.splice(0).map((client) => client.close().catch(() => {})),
  );
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(
  options: Partial<
    Pick<
      AgentMapMcpRouterOptions,
      "createToolServer" | "createTransport" | "onEvent" | "readSnapshotFor"
    >
  > & { mapVersionHistoryLimit?: number } = {},
) {
  const { mapVersionHistoryLimit, ...routerOptions } = options;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-mcp-"));
  const capabilities = new AgentMapCapabilityRegistry();
  const workspaceStore = new AgentMapWorkspaceStore(root);
  const service = new AgentMapProposalService(workspaceStore, {
    ...(mapVersionHistoryLimit === undefined ? {} : { versionHistoryLimit: mapVersionHistoryLimit }),
  });
  const buildPlanService = new BuildPlanService(new BuildPlanStore(workspaceStore));
  const mcp = createAgentMapMcpRouter({ capabilities, service, buildPlanService, ...routerOptions });
  const app = express();
  app.use(express.json());
  app.use(mcp.router);
  const http = createServer(app);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const url = new URL(
    `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp/agent-map`,
  );
  cleanups.push(async () => {
    await mcp.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { capabilities, url, workspaceStore };
}

async function connect(url: URL, token: string) {
  const client = new Client({ name: "test-client", version: "1" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("Agent Map Streamable HTTP MCP", () => {
  it.each<ProjectAgentSession>([
    { projectId, sessionId: "first", userId: "user" },
    { projectId, sessionId: "created", userId: "user" },
    { projectId, sessionId: "resumed", userId: "user" },
  ])("exposes the same strict tools to $sessionId", async (identity) => {
    const { capabilities, url } = await fixture();
    const issued = capabilities.issue(identity);
    const client = await connect(url, issued.token);
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      "agent_map_propose",
      "agent_map_read",
      "agent_map_validate",
      "build_plan_apply",
      "build_plan_read",
      "build_plan_rebase",
      "build_plan_validate",
    ]);
    const nonStrict = tools.tools.filter((tool) => !(tool.inputSchema.additionalProperties === false ||
      (Array.isArray(tool.inputSchema.anyOf) && tool.inputSchema.anyOf.every((variant) =>
        typeof variant === "object" && variant !== null && "additionalProperties" in variant &&
        variant.additionalProperties === false)))).map(({ name, inputSchema }) => ({ name, inputSchema }));
    expect(nonStrict).toEqual([]);
    await expect(client.callTool({ name: "build_plan_read", arguments: { kind: "current" } }))
      .resolves.toMatchObject({ structuredContent: { plan: null, history: [] } });
    await expect(client.callTool({ name: "build_plan_read", arguments: { kind: "exact" } }))
      .resolves.toMatchObject({
        isError: true,
        structuredContent: { code: "malformed_input", recovery: "correct" },
      });
    const validate = tools.tools.find(
      ({ name }) => name === "agent_map_validate",
    )!;
    const propose = tools.tools.find(
      ({ name }) => name === "agent_map_propose",
    )!;
    const operationItems = (
      validate.inputSchema as {
        properties?: {
          operations?: {
            items?: {
              anyOf?: Array<{
                properties?: { kind?: { const?: string } };
              }>;
            };
          };
        };
      }
    ).properties?.operations?.items;
    expect(
      operationItems?.anyOf?.map(
        (operation) => operation.properties?.kind?.const,
      ),
    ).toEqual([
      "add-node",
      "update-node",
      "remove-node",
      "add-relationship",
      "update-relationship",
      "remove-relationship",
    ]);
    expect(propose.inputSchema).toEqual(validate.inputSchema);
  });

  it("reads, validates without mutation, proposes once, and rejects a rotated token", async () => {
    const onEvent = vi.fn();
    const { capabilities, url } = await fixture({ onEvent });
    const identity: ProjectAgentSession = {
      projectId,
      sessionId: "session-1",
      userId: "user",
    };
    const first = capabilities.issue(identity);
    const client = await connect(url, first.token);
    const malformed = await client.callTool({
      name: "agent_map_validate",
      arguments: {
        schemaVersion: 1,
        proposalId: null,
        expectedVersion: 0,
        requestId: "malformed-request",
        operations: [{ kind: "invented-operation" }],
      },
    });
    expect(malformed).toMatchObject({
      isError: true,
      structuredContent: {
        code: "validation_failed",
        issues: [
          {
            code: "malformed_input",
            operationIndex: 0,
            path: ["operations", 0, "kind"],
            recovery: "correct",
          },
        ],
        recovery: "correct",
      },
    });
    const request = {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "request-1",
      operations: [
        {
          kind: "add-node",
          draftRef: "research",
          node: {
            kind: "agent",
            name: "Research",
            purpose: "Research sources",
            ownerAgent: null,
            contractRefs: [],
          },
        },
      ],
    };
    const validated = await client.callTool({
      name: "agent_map_validate",
      arguments: request,
    });
    expect(validated.isError).not.toBe(true);
    const before = await client.callTool({
      name: "agent_map_read",
      arguments: {},
    });
    expect(before.structuredContent).toMatchObject({ proposal: null });
    const proposed = await client.callTool({
      name: "agent_map_propose",
      arguments: request,
    });
    expect(proposed.structuredContent).toMatchObject({ version: 1 });
    const replayed = await client.callTool({
      name: "agent_map_propose",
      arguments: request,
    });
    expect(replayed.structuredContent).toEqual(proposed.structuredContent);
    expect(onEvent).toHaveBeenCalled();
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("role");
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(
      "Research sources",
    );

    capabilities.rotate(identity);
    await expect(
      client.callTool({ name: "agent_map_read", arguments: {} }),
    ).rejects.toThrow();
  });

  it("validates, applies, reads, and explicitly rebases a shared plan through the universal tools", async () => {
    const { capabilities, url, workspaceStore } = await fixture();
    const identity: ProjectAgentSession = {
      projectId,
      sessionId: "plan-author",
      userId: "user",
    };
    const client = await connect(url, capabilities.issue(identity).token);
    const mapRequest = {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "map-for-plan",
      operations: [{
        kind: "add-node",
        draftRef: "research",
        node: {
          kind: "agent",
          name: "Research",
          purpose: "Research sources",
          ownerAgent: null,
          contractRefs: [],
        },
      }],
    };
    const proposed = await client.callTool({
      name: "agent_map_propose",
      arguments: mapRequest,
    });
    const firstAggregate = await workspaceStore.readAggregate(projectId);
    const firstMap = firstAggregate.current.map!;
    const planRequest = {
      schemaVersion: 1,
      requestId: "plan-create",
      expectedMap: {
        versionId: firstMap.versionId,
        contentDigest: firstMap.contentDigest,
      },
      expectedPlan: null,
      operations: [{
        op: "replace-content",
        content: {
          outcome: "Deliver a daily research report.",
          nonGoals: [],
          milestones: [],
          sequenceGates: [],
          sharedConstraints: [],
          repositoryIntents: [],
          integrationCriteria: [],
          acceptanceCriteria: [],
          decisions: [],
          assignments: [],
          unresolvedDecisions: [],
          risks: [],
        },
      }],
    };

    const validated = await client.callTool({
      name: "build_plan_validate",
      arguments: planRequest,
    });
    expect(validated).toMatchObject({
      structuredContent: { preview: { version: 1 }, created: true },
    });
    expect((await workspaceStore.readAggregate(projectId)).current.buildPlan).toBeNull();

    const applied = await client.callTool({
      name: "build_plan_apply",
      arguments: planRequest,
    });
    expect(applied).toMatchObject({
      structuredContent: { plan: { semanticDigest: expect.any(String) }, created: true },
    });
    const firstPlan = (await workspaceStore.readAggregate(projectId)).current.buildPlan!;
    await expect(client.callTool({
      name: "build_plan_read",
      arguments: {
        kind: "exact",
        planId: firstPlan.planId,
        versionId: firstPlan.versionId,
        semanticDigest: firstPlan.semanticDigest,
      },
    })).resolves.toMatchObject({ structuredContent: { plan: { version: 1 } } });

    await client.callTool({
      name: "agent_map_propose",
      arguments: {
        ...mapRequest,
        proposalId: (proposed.structuredContent as { proposalId: string }).proposalId,
        expectedVersion: 1,
        requestId: "map-for-rebase",
        operations: [{
          kind: "add-node",
          draftRef: "market-data",
          node: {
            kind: "resource",
            name: "Market data",
            purpose: "Supply current prices",
            ownerAgent: null,
            contractRefs: [],
          },
        }],
      },
    });
    const secondMap = (await workspaceStore.readAggregate(projectId)).current.map!;
    const rebased = await client.callTool({
      name: "build_plan_rebase",
      arguments: {
        schemaVersion: 1,
        requestId: "plan-rebase",
        expectedPlan: {
          planId: firstPlan.planId,
          versionId: firstPlan.versionId,
          semanticDigest: firstPlan.semanticDigest,
        },
        fromMap: {
          versionId: firstMap.versionId,
          contentDigest: firstMap.contentDigest,
        },
        toMap: {
          versionId: secondMap.versionId,
          contentDigest: secondMap.contentDigest,
        },
        resolutions: [],
      },
    });
    expect(rebased).toMatchObject({
      structuredContent: {
        plan: { semanticDigest: firstPlan.semanticDigest },
        created: true,
      },
    });
    expect((await workspaceStore.readAggregate(projectId)).buildPlanVersions.at(-1))
      .toMatchObject({ version: 2, map: secondMap });
  });

  it("returns bounded recovery for request-local and durable map quotas", async () => {
    const { capabilities, url, workspaceStore } = await fixture({ mapVersionHistoryLimit: 1 });
    const identity: ProjectAgentSession = { projectId, sessionId: "quota-session", userId: "user" };
    const client = await connect(url, capabilities.issue(identity).token);
    const firstMap = await client.callTool({
      name: "agent_map_propose",
      arguments: {
        schemaVersion: 1, proposalId: null, expectedVersion: 0, requestId: "first-map",
        operations: [{
          kind: "add-node", draftRef: "research",
          node: { kind: "agent", name: "Research", purpose: "Research", ownerAgent: null, contractRefs: [] },
        }],
      },
    });
    const aggregate = await workspaceStore.readAggregate(projectId);
    const currentMap = aggregate.current.map!;
    const oversizedPlan = await client.callTool({
      name: "build_plan_validate",
      arguments: {
        schemaVersion: 1, requestId: "oversized-plan",
        expectedMap: { versionId: currentMap.versionId, contentDigest: currentMap.contentDigest },
        expectedPlan: null,
        operations: [{
          op: "replace-content",
          content: {
            outcome: "Plan", nonGoals: [],
            milestones: Array.from({ length: 128 }, (_, index) => ({
              id: { clientRef: `milestone-${index}` }, ordinal: index + 1,
              title: `Milestone ${index + 1}`, outcome: "Complete", dependsOn: [],
            })),
            sequenceGates: [], sharedConstraints: [], repositoryIntents: [],
            integrationCriteria: [], acceptanceCriteria: [], decisions: [], assignments: [],
            unresolvedDecisions: [],
            risks: [{ id: { clientRef: "risk-over-limit" }, description: "Capacity", mitigation: "Split request" }],
          },
        }],
      },
    });
    expect(oversizedPlan).toMatchObject({
      isError: true,
      structuredContent: { code: "request_too_large", recovery: "correct" },
    });

    const mapQuota = await client.callTool({
      name: "agent_map_propose",
      arguments: {
        schemaVersion: 1,
        proposalId: (firstMap.structuredContent as { proposalId: string }).proposalId,
        expectedVersion: 1, requestId: "second-map",
        operations: [{
          kind: "add-node", draftRef: "publisher",
          node: { kind: "agent", name: "Publisher", purpose: "Publish", ownerAgent: null, contractRefs: [] },
        }],
      },
    });
    expect(mapQuota).toMatchObject({
      isError: true,
      structuredContent: { code: "quota_exceeded", recovery: "manual_intervention" },
    });
    expect(await workspaceStore.readAggregate(projectId)).toEqual(aggregate);
  });

  it.each([
    new AgentMapProposalQuotaError("map_versions"),
    new AgentBriefAppendQuotaError("brief_versions"),
    new AgentMapAggregateError("malformed_state"),
    new AgentMapAggregateError("unsupported_schema", 3),
    new AgentMapWorkspaceStoreError("malformed_state"),
    new AgentMapWorkspaceStoreError("unsupported_schema", 3),
  ])("returns manual intervention for permanent storage failure $name $code", async (error) => {
    const { capabilities, url } = await fixture({ readSnapshotFor: async () => { throw error; } });
    const client = await connect(url, capabilities.issue({ projectId, userId: "user", sessionId: "permanent-storage" }).token);
    await expect(client.callTool({ name: "agent_map_read", arguments: {} })).resolves.toMatchObject({
      isError: true, structuredContent: { code: error.code, recovery: "manual_intervention" },
    });
  });

  it("returns a bounded terminal recovery when the capability project is unavailable", async () => {
    const { capabilities, url } = await fixture({
      readSnapshotFor: async () => {
        throw new AgentMapMcpProjectUnavailableError();
      },
    });
    const issued = capabilities.issue({
      projectId,
      sessionId: "missing-project",
      userId: "user",
    });
    const client = await connect(url, issued.token);

    const result = await client.callTool({
      name: "agent_map_read",
      arguments: {},
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "project_unavailable",
        recovery: "reread",
      },
    });
  });

  it("closes both resources when initialize fails before session registration", async () => {
    const serverClose = vi.fn(async () => {});
    const transportClose = vi.fn(async () => {});
    const { capabilities, url } = await fixture({
      createToolServer: (...args) => {
        const server = createAgentMapToolServer(...args);
        const close = server.close.bind(server);
        vi.spyOn(server, "close").mockImplementation(async () => {
          serverClose();
          await close();
        });
        return server;
      },
      createTransport: (options) => {
        const transport = new StreamableHTTPServerTransport(options);
        const close = transport.close.bind(transport);
        vi.spyOn(transport, "handleRequest").mockRejectedValue(
          new Error("initialize failed before registration"),
        );
        vi.spyOn(transport, "close").mockImplementation(async () => {
          await transportClose();
          await close();
        });
        return transport;
      },
    });
    const issued = capabilities.issue({
      projectId,
      sessionId: "failed-initialize",
      userId: "user",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
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

    expect(response.status).toBe(500);
    expect(serverClose).toHaveBeenCalledOnce();
    expect(transportClose).toHaveBeenCalledOnce();
  });
});
