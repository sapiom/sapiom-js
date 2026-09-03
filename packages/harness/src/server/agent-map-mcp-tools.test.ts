import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import { AgentMapProposalService } from "../core/agent-map-proposal-service.js";
import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";
import { createAgentMapToolServer } from "./agent-map-mcp-tools.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";

async function toolsFor(identity: PlanningSessionIdentity) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createAgentMapToolServer(
    identity,
    new AgentMapProposalService(
      new AgentMapWorkspaceStore(`/tmp/agent-map-tools-${identity.sessionId}`),
    ),
    {
      buildPlanService: {} as never,
    },
  );
  const client = new Client({ name: "tool-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  await client.close();
  await server.close();
  return tools.tools;
}

describe("Agent Map MCP plan-authoring discovery", () => {
  it("adds plan tools only for the trusted map planner and keeps E2 tools identical", async () => {
    const planner = await toolsFor({
      projectId,
      sessionId: "planner",
      userId: "user",
      role: "map-planner",
    });
    const builder = await toolsFor({
      projectId,
      sessionId: "builder",
      userId: "user",
      role: "agent-builder",
      assignment: { kind: "unplanned" },
    });
    expect(planner.map(({ name }) => name).sort()).toEqual([
      "agent_map_propose",
      "agent_map_read",
      "agent_map_validate",
      "build_plan_apply",
      "build_plan_read",
      "build_plan_rebase",
      "build_plan_validate",
    ]);
    expect(builder.map(({ name }) => name).sort()).toEqual([
      "agent_map_propose",
      "agent_map_read",
      "agent_map_validate",
    ]);
    expect(
      planner.every((tool) => tool.inputSchema.additionalProperties === false),
    ).toBe(true);
  });

  it("returns method-not-found to builders and emits content-free planner telemetry", async () => {
    const events: unknown[] = [];
    const connect = async (identity: PlanningSessionIdentity) => {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const read = vi.fn(async () => ({
        schemaVersion: 1,
        plan: { version: 3 },
        source: { kind: "proposal", version: 2 },
        diagnostics: [],
        secret: "mission text must not enter telemetry",
      }));
      const server = createAgentMapToolServer(
        identity,
        new AgentMapProposalService(
          new AgentMapWorkspaceStore(
            `/tmp/agent-map-tools-call-${identity.sessionId}`,
          ),
        ),
        {
          buildPlanService: { read } as never,
          onEvent: (event) => events.push(event),
        },
      );
      const client = new Client({ name: "tool-call-test", version: "1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, server, read };
    };
    const builder = await connect({
      projectId,
      sessionId: "builder-call",
      userId: "user",
      role: "agent-builder",
      assignment: { kind: "unplanned" },
    });
    await expect(
      builder.client.callTool({
        name: "build_plan_read",
        arguments: { schemaVersion: 1 },
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: [
        expect.objectContaining({ text: expect.stringMatching(/not found/iu) }),
      ],
    });
    expect(builder.read).not.toHaveBeenCalled();
    await builder.client.close();
    await builder.server.close();

    const planner = await connect({
      projectId,
      sessionId: "planner-call",
      userId: "user",
      role: "map-planner",
    });
    await planner.client.callTool({
      name: "build_plan_read",
      arguments: { schemaVersion: 1 },
    });
    expect(JSON.stringify(events)).not.toContain("mission text");
    expect(events).toContainEqual(
      expect.objectContaining({
        tool: "build_plan_read",
        outcome: "ok",
        role: "map-planner",
        planVersion: 3,
        sourceKind: "proposal",
        sourceVersion: 2,
      }),
    );
    await planner.client.close();
    await planner.server.close();
  });
});
