import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import { AgentMapCapabilityRegistry } from "../core/agent-map-capability-registry.js";
import { AgentMapProposalService } from "../core/agent-map-proposal-service.js";
import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";
import { createAgentMapMcpRouter } from "./agent-map-mcp.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const clients: Client[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-mcp-"));
  const capabilities = new AgentMapCapabilityRegistry();
  const service = new AgentMapProposalService(new AgentMapWorkspaceStore(root));
  const mcp = createAgentMapMcpRouter({ capabilities, service });
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
});
