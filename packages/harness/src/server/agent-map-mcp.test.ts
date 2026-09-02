import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import { AgentMapCapabilityRegistry } from "../core/agent-map-capability-registry.js";
import { AgentMapProposalService } from "../core/agent-map-proposal-service.js";
import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";
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
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(
  options: Partial<
    Pick<
      AgentMapMcpRouterOptions,
      "createToolServer" | "createTransport" | "readSnapshotFor"
    >
  > = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-mcp-"));
  const capabilities = new AgentMapCapabilityRegistry();
  const service = new AgentMapProposalService(new AgentMapWorkspaceStore(root));
  const mcp = createAgentMapMcpRouter({ capabilities, service, ...options });
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
  return { capabilities, url };
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
  it.each<PlanningSessionIdentity>([
    { projectId, sessionId: "planner", userId: "user", role: "map-planner" },
    {
      projectId,
      sessionId: "planned",
      userId: "user",
      role: "agent-builder",
      assignment: { kind: "planned", agentId: "agent-1" },
    },
    {
      projectId,
      sessionId: "manual",
      userId: "user",
      role: "agent-builder",
      assignment: { kind: "unplanned" },
    },
  ])("exposes the same strict tools to $role/$sessionId", async (identity) => {
    const { capabilities, url } = await fixture();
    const issued = capabilities.issue(identity);
    const client = await connect(url, issued.token);
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      "agent_map_propose",
      "agent_map_read",
      "agent_map_validate",
    ]);
    expect(tools.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    const validate = tools.tools.find(({ name }) => name === "agent_map_validate")!;
    const propose = tools.tools.find(({ name }) => name === "agent_map_propose")!;
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
    const { capabilities, url } = await fixture();
    const identity: PlanningSessionIdentity = {
      projectId,
      sessionId: "planner",
      userId: "user",
      role: "map-planner",
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
    const validated = await client.callTool({ name: "agent_map_validate", arguments: request });
    expect(validated.isError).not.toBe(true);
    const before = await client.callTool({ name: "agent_map_read", arguments: {} });
    expect(before.structuredContent).toMatchObject({ proposal: null });
    const proposed = await client.callTool({ name: "agent_map_propose", arguments: request });
    expect(proposed.structuredContent).toMatchObject({ version: 1 });
    const replayed = await client.callTool({ name: "agent_map_propose", arguments: request });
    expect(replayed.structuredContent).toEqual(proposed.structuredContent);

    capabilities.rotate(identity);
    await expect(client.callTool({ name: "agent_map_read", arguments: {} })).rejects.toThrow();
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
      role: "map-planner",
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
      role: "map-planner",
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
