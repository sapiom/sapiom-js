import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import { AgentMapProposalService } from "../core/agent-map-proposal-service.js";
import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";
import { BuildPlanServiceError } from "../core/build-plan-service.js";
import {
  BuilderPlanningSessionError,
  planningResultSubmitRequestSchema,
} from "../core/builder-planning-session.js";
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
    const manualBuilder = await toolsFor({
      projectId,
      sessionId: "builder",
      userId: "user",
      role: "agent-builder",
      assignment: { kind: "unplanned" },
    });
    const plannedBuilder = await toolsFor({
      projectId,
      sessionId: "planned-builder",
      userId: "user",
      role: "agent-builder",
      assignment: { kind: "planned", agentId: "agent-1" },
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
    for (const builder of [manualBuilder, plannedBuilder])
      expect(builder.map(({ name }) => name).sort()).toEqual([
        "agent_map_propose",
        "agent_map_read",
        "agent_map_validate",
      ]);
    expect(
      planner.every((tool) => tool.inputSchema.additionalProperties === false),
    ).toBe(true);
  });

  it("reports reachable and locally unreachable fan-out counts honestly", async () => {
    const identity: PlanningSessionIdentity = {
      projectId,
      sessionId: "planner-partial-fanout",
      userId: "user",
      role: "map-planner",
    };
    const assignmentIds = ["assignment-a", "assignment-b"];
    const openOrReuse = vi.fn(async () => ({
      bindings: assignmentIds.map((assignmentId) => ({ assignmentId })),
      unreachableAssignmentIds: [assignmentIds[1]],
    }));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createAgentMapToolServer(
      identity,
      new AgentMapProposalService(
        new AgentMapWorkspaceStore("/tmp/agent-map-tools-partial-fanout"),
      ),
      { builderPlanningService: { openOrReuse } as never },
    );
    const client = new Client({ name: "partial-fanout", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const toolArguments = {
      approvalId: "approval-opaque",
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
      assignmentIds,
    };
    const result = await client.callTool({
      name: "build_plan_open_planning_sessions",
      arguments: toolArguments,
    });

    expect(result).toMatchObject({
      structuredContent: {
        unreachableAssignmentIds: ["assignment-b"],
      },
      content: [
        expect.objectContaining({
          text: expect.stringContaining(
            "Reconciled 1 planning session; 1 is locally unreachable.",
          ),
        }),
      ],
    });

    const pluralAssignmentIds = [...assignmentIds, "assignment-c"];
    openOrReuse.mockResolvedValueOnce({
      bindings: pluralAssignmentIds.map((assignmentId) => ({ assignmentId })),
      unreachableAssignmentIds: ["assignment-b"],
    });
    const plural = await client.callTool({
      name: "build_plan_open_planning_sessions",
      arguments: { ...toolArguments, assignmentIds: pluralAssignmentIds },
    });
    expect(plural.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "Reconciled 2 planning sessions; 1 is locally unreachable.",
        ),
      }),
    ]);

    await client.close();
    await server.close();
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
        projectId,
        sessionId: "planner-call",
        planVersion: 3,
        sourceKind: "proposal",
        sourceVersion: 2,
      }),
    );
    await planner.client.close();
    await planner.server.close();
  });

  it.each([
    ["build_plan_validate", "operations"],
    ["build_plan_apply", "operations"],
    ["build_plan_rebase", "resolutions"],
  ] as const)(
    "returns structured invalid_operation for malformed %s collections",
    async (tool, malformedField) => {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const invalid = vi.fn(async () => {
        throw new BuildPlanServiceError("invalid_operation", [
          { path: malformedField, message: "Expected array" },
        ]);
      });
      const server = createAgentMapToolServer(
        {
          projectId,
          sessionId: `malformed-${tool}`,
          userId: "user",
          role: "map-planner",
        },
        new AgentMapProposalService(
          new AgentMapWorkspaceStore(`/tmp/agent-map-tools-${tool}`),
        ),
        {
          buildPlanService: {
            validate: invalid,
            apply: invalid,
            rebase: invalid,
          } as never,
        },
      );
      const client = new Client({ name: "malformed-test", version: "1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const source = {
        kind: "proposal",
        proposalId: "proposal_00000000-0000-7000-8000-000000000005",
        version: 1,
        graphDigest: `sha256:${"0".repeat(64)}`,
      };
      const arguments_ =
        tool === "build_plan_rebase"
          ? {
              schemaVersion: 1,
              planId: "build-plan_00000000-0000-7000-8000-000000000002",
              expectedPlanVersion: 1,
              fromSource: source,
              toSource: source,
              requestId: "request-malformed",
              resolutions: null,
            }
          : {
              schemaVersion: 1,
              planId: null,
              expectedPlanVersion: null,
              expectedSource: source,
              ...(tool === "build_plan_apply"
                ? { requestId: "request-malformed" }
                : {}),
              operations: null,
            };
      const result = await client.callTool({
        name: tool,
        arguments: arguments_,
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "invalid_operation",
          recovery: "correct",
        },
      });
      expect(invalid).toHaveBeenCalledOnce();
      await client.close();
      await server.close();
    },
  );

  it("returns actionable bounded recovery for oversized authoring results", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const apply = vi.fn(async () => {
      throw new BuildPlanServiceError("result_too_large", [
        {
          path: "operations",
          message: "Split the authoring work across plan versions",
        },
      ]);
    });
    const server = createAgentMapToolServer(
      {
        projectId,
        sessionId: "oversized-result",
        userId: "user",
        role: "map-planner",
      },
      new AgentMapProposalService(
        new AgentMapWorkspaceStore("/tmp/agent-map-tools-oversized"),
      ),
      { buildPlanService: { apply } as never },
    );
    const client = new Client({ name: "oversized-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "build_plan_apply",
      arguments: {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: {
          kind: "proposal",
          proposalId: "proposal_00000000-0000-7000-8000-000000000005",
          version: 1,
          graphDigest: `sha256:${"0".repeat(64)}`,
        },
        requestId: "request-oversized",
        operations: [
          {
            op: "set-project-outcome",
            outcome: { summary: "Bound this result" },
          },
        ],
      },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "result_too_large",
        recovery: "split_batch",
        issues: [
          expect.objectContaining({
            path: "operations",
            message: expect.stringContaining("Split"),
          }),
        ],
      },
    });
    await client.close();
    await server.close();
  });

  it("returns bounded invalid_request for duplicate planning result identities", async () => {
    const identity: PlanningSessionIdentity = {
      projectId,
      sessionId: "planned-builder-invalid",
      userId: "user",
      role: "agent-builder",
      assignment: { kind: "planned", agentId: "agent-1" },
    };
    const submitResult = vi.fn(async (_identity, request) => {
      const parsed = planningResultSubmitRequestSchema.safeParse(request);
      if (!parsed.success)
        throw new BuilderPlanningSessionError(
          "invalid_request",
          parsed.error.issues.slice(0, 64).map((issue) => ({
            path: issue.path.join("."),
            message: issue.code,
          })),
        );
      throw new Error("unexpected valid request");
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createAgentMapToolServer(
      identity,
      new AgentMapProposalService(
        new AgentMapWorkspaceStore("/tmp/agent-map-tools-invalid-planning"),
      ),
      { builderPlanningService: { submitResult } as never },
    );
    const client = new Client({ name: "invalid-planning", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "planning_result_submit",
      arguments: {
        schemaVersion: 1,
        expected: {
          assignmentId: "assignment_00000000-0000-7000-8000-000000000001",
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
        },
        requestId: "submit-duplicates",
        status: "ready",
        implementationPlan: [
          {
            stepId: "step-one",
            ordinal: 1,
            description: "One",
            verification: "One",
          },
          {
            stepId: "step-one",
            ordinal: 1,
            description: "Two",
            verification: "Two",
          },
        ],
        risks: [],
        questions: [],
        proposedMapOperationIds: [],
      },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "invalid_request",
        recovery: "reread",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("stepId") }),
          expect.objectContaining({ path: expect.stringContaining("ordinal") }),
        ]),
      },
    });
    expect(submitResult).toHaveBeenCalledOnce();
    await client.close();
    await server.close();
  });
});
