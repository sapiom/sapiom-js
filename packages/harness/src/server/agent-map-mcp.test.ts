import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ProjectAgentSession } from "@sapiom/agent-map";
import { AgentMapAggregateError } from "@sapiom/agent-map/node/agent-map-aggregate-migration";
import { AgentMapCapabilityRegistry } from "../core/agent-map-capability-registry.js";
import { AgentMapProposalService, AgentMapProposalQuotaError } from "@sapiom/agent-map/node/agent-map-proposal-service";
import { AgentMapWorkspaceStore, AgentMapWorkspaceStoreError } from "@sapiom/agent-map/node/agent-map-workspace-store";
import {
  createAgentMapMcpRouter,
  type AgentMapMcpRouterOptions,
} from "./agent-map-mcp.js";
import {
  AgentMapMcpProjectUnavailableError,
  createAgentMapToolServer,
} from "./agent-map-mcp-tools.js";
import { PROJECT_AGENT_PROMPT_APPENDIX } from "../profiles/project-agent.js";

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
      "createToolServer" | "createTransport" | "onEvent" | "readSnapshotFor" | "hostContextFor"
    >
  > & {
    mapVersionHistoryLimit?: number;
  } = {},
) {
  const { mapVersionHistoryLimit, ...routerOptions } = options;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-mcp-"));
  const capabilities = new AgentMapCapabilityRegistry({ now: () => Date.now() });
  const workspaceStore = new AgentMapWorkspaceStore(root);
  const service = new AgentMapProposalService(workspaceStore, {
    ...(mapVersionHistoryLimit === undefined ? {} : { versionHistoryLimit: mapVersionHistoryLimit }),
  });
  const mcp = createAgentMapMcpRouter({ capabilities, service, ...routerOptions });
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
  return { capabilities, url, workspaceStore, service };
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
    ]);
    for (const tool of tools.tools) {
      expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain(tool.name);
    }
    const descriptions = Object.fromEntries(tools.tools.map(({ name, description }) => [name, description]));
    expect(descriptions.agent_map_read).toContain("null if empty");
    expect(descriptions.agent_map_validate).toContain("Validation alone never updates");
    expect(descriptions.agent_map_propose).toContain("not an approval request");
    const mapInput = tools.tools.find(({ name }) => name === "agent_map_propose")!.inputSchema;
    expect(JSON.stringify(mapInput.properties?.proposalId)).toContain("agent_map_read");
    expect(JSON.stringify(mapInput.properties?.expectedVersion)).toContain("0");
    const nonStrict = tools.tools.filter((tool) => !(tool.inputSchema.additionalProperties === false ||
      (Array.isArray(tool.inputSchema.anyOf) && tool.inputSchema.anyOf.every((variant) =>
        typeof variant === "object" && variant !== null && "additionalProperties" in variant &&
        variant.additionalProperties === false)))).map(({ name, inputSchema }) => ({ name, inputSchema }));
    expect(nonStrict).toEqual([]);
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

  it("returns bounded recovery for durable map quotas", async () => {
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


describe("authenticated Studio host context", () => {
  const identity = {
    projectId,
    sessionId: "host-session",
    userId: "local:machine",
  };
  const requestContext = (url: URL, token?: string, query = "") =>
    fetch(`${url}/host-context${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  it("returns only server-derived scope and implemented support without caching credentials", async () => {
    const lookup = vi.fn(async () => ({ stateRoot: "/private/custom/state" }));
    const { capabilities, url } = await fixture({ hostContextFor: lookup });
    const issued = capabilities.issue(identity);
    const response = await requestContext(url, issued.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      host: "sapiom-studio",
      ...identity,
      stateRoot: "/private/custom/state",
      generation: issued.generation,
      capabilities: ["session-context"],
    });
    expect(lookup).toHaveBeenCalledWith(identity);
    expect(
      (
        await requestContext(
          url,
          issued.token,
          "?projectId=foreign&userId=foreign",
        )
      ).status,
    ).toBe(400);
  });

  it("rejects missing, wrong, expired, revoked and rotated credentials", async () => {
    const { capabilities, url } = await fixture({
      hostContextFor: async () => ({ stateRoot: "/state" }),
    });
    expect((await requestContext(url)).status).toBe(401);
    expect((await requestContext(url, "wrong")).status).toBe(401);
    const first = capabilities.issue(identity);
    const second = capabilities.rotate(identity);
    expect((await requestContext(url, first.token)).status).toBe(401);
    expect((await requestContext(url, second.token)).status).toBe(200);
    capabilities.revokeSession(identity.sessionId);
    expect((await requestContext(url, second.token)).status).toBe(401);
    const expired = capabilities.issue(identity);
    const clock = vi.spyOn(Date, "now").mockReturnValue(expired.expiresAt + 1);
    try {
      expect((await requestContext(url, expired.token)).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["revoke", "rotate"])(
    "rejects %s during awaited scope lookup",
    async (action) => {
      let release!: () => void;
      let entered!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lookupStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const { capabilities, url } = await fixture({
        hostContextFor: async () => {
          entered();
          await pending;
          return { stateRoot: "/state" };
        },
      });
      const issued = capabilities.issue(identity);
      const response = requestContext(url, issued.token);
      await lookupStarted;
      if (action === "rotate") capabilities.rotate(identity);
      else capabilities.revokeSession(identity.sessionId);
      release();
      expect((await response).status).toBe(401);
    },
  );

  it("bounds unavailable scope errors and never echoes exception details", async () => {
    const { capabilities, url } = await fixture({
      hostContextFor: async () => {
        throw new Error("private-path-and-token");
      },
    });
    const response = await requestContext(
      url,
      capabilities.issue(identity).token,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("private-path-and-token");
  });
});
