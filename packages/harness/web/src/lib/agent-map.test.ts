import { describe, expect, it } from "vitest";
import type { StudioProjectSummary } from "@shared/agent-map";

import {
  mostSpecificStudioScope,
  parseAcceptedProposalDelta,
  parseAgentMapWorkspaceResponse,
  resolveStudioWorkspaceSelection,
  routeAcceptedProposalDelta,
} from "./agent-map";
import { MockApi } from "./api";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-01T12:00:00.000Z";

function validResponse(): unknown {
  return {
    schemaVersion: 1,
    project: {
      projectId,
      identityVersion: 1,
      displayName: "Market Research",
      bindings: [
        {
          id: "root_00000000-0000-4000-8000-000000000001",
          status: "active",
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    workspace: {
      projectId,
      schemaVersion: 1,
      recordVersion: 1,
      confirmedRevisionId: null,
      activeProposalId: null,
      projectBuildPlanId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    proposal: null,
  };
}

describe("parseAgentMapWorkspaceResponse", () => {
  it("accepts the strict path-free public shape", () => {
    expect(parseAgentMapWorkspaceResponse(validResponse(), projectId)).toEqual(
      validResponse(),
    );
  });

  it("accepts and strictly parses a populated proposal", () => {
    const value = validResponse() as any;
    const proposalId = "proposal_00000000-0000-7000-8000-000000000001";
    const nodeId = "node_00000000-0000-7000-8000-000000000002";
    const operationId = "operation_00000000-0000-7000-8000-000000000003";
    const operation = {
      kind: "add-node",
      node: {
        id: nodeId,
        kind: "agent",
        name: "Research",
        purpose: "Research",
        ownerAgentId: null,
        contractRefs: [],
      },
    };
    value.workspace.activeProposalId = proposalId;
    value.workspace.recordVersion = 2;
    value.proposal = {
      schemaVersion: 1,
      id: proposalId,
      projectId,
      baseRevisionId: null,
      version: 1,
      nodes: [operation.node],
      relationships: [],
      history: [
        {
          id: operationId,
          requestId: "request-1",
          acceptedVersion: 1,
          operation,
          actor: {
            userId: "user-1",
            sessionId: "session-1",
          },
          acceptedAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(parseAgentMapWorkspaceResponse(value, projectId)).toEqual(value);
    value.proposal.history[0].operation.node.privatePath = "/secret";
    expect(() => parseAgentMapWorkspaceResponse(value, projectId)).toThrow(
      "Invalid Agent Map workspace response",
    );
  });

  it("uses the same public shape in mock mode", async () => {
    const api = new MockApi();
    const state = await api.getState();
    const project = state.studioProjects?.[0];
    expect(project).toBeDefined();
    expect(
      parseAgentMapWorkspaceResponse(
        await api.getAgentMapWorkspace(project!.projectId),
        project!.projectId,
      ).workspace,
    ).toMatchObject({
      projectId: project!.projectId,
      schemaVersion: 1,
      recordVersion: 1,
    });
  });

  it.each([
    ["extra field", (value: any) => (value.workspace.privateRoot = "/secret")],
    [
      "path display name",
      (value: any) => (value.project.displayName = "/secret/project"),
    ],
    [
      "private repository field",
      (value: any) => (value.project.bindings[0].repositoryId = "repo-private"),
    ],
    [
      "project mismatch",
      (value: any) =>
        (value.workspace.projectId =
          "project_00000000-0000-4000-8000-000000000002"),
    ],
    ["future schema", (value: any) => (value.workspace.schemaVersion = 2)],
    [
      "negative record version",
      (value: any) => (value.workspace.recordVersion = -1),
    ],
    [
      "invalid timestamp",
      (value: any) => (value.workspace.updatedAt = "yesterday"),
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = validResponse();
    mutate(value);
    expect(() => parseAgentMapWorkspaceResponse(value, projectId)).toThrow(
      "Invalid Agent Map workspace response",
    );
  });
});

describe("parseAcceptedProposalDelta", () => {
  it("accepts only the exact attributed contiguous shape", () => {
    const delta = {
      schemaVersion: 1,
      projectId,
      proposalId: "proposal_00000000-0000-7000-8000-000000000001",
      fromVersion: 1,
      version: 2,
      operationIds: ["operation_00000000-0000-7000-8000-000000000003"],
      operations: [
        {
          kind: "update-node",
          nodeId: "node_00000000-0000-7000-8000-000000000002",
          changes: { purpose: "Find sources" },
        },
      ],
      actor: {
        userId: "user-1",
        sessionId: "session-1",
      },
      acceptedAt: timestamp,
    };
    expect(parseAcceptedProposalDelta(delta, projectId)).toEqual(delta);
    expect(() =>
      parseAcceptedProposalDelta(
        { ...delta, privatePath: "/secret" },
        projectId,
      ),
    ).toThrow("Invalid Agent Map proposal delta");
    expect(() =>
      parseAcceptedProposalDelta({ ...delta, version: 3 }, projectId),
    ).toThrow("Invalid Agent Map proposal delta");

    const foreignProjectId = "project_00000000-0000-4000-8000-000000000002";
    expect(
      routeAcceptedProposalDelta(
        { ...delta, projectId: foreignProjectId },
        projectId,
      ),
    ).toMatchObject({
      status: "accepted",
      delta: { projectId: foreignProjectId },
    });
    expect(
      routeAcceptedProposalDelta(
        { ...delta, projectId: foreignProjectId, version: 3 },
        projectId,
      ),
    ).toEqual({ status: "ignored" });
    expect(
      routeAcceptedProposalDelta({ ...delta, version: 3 }, projectId),
    ).toEqual({ status: "malformed-active" });
  });
});

describe("resolveStudioWorkspaceSelection", () => {
  it("defaults to map without treating a first visit as a repair", () => {
    expect(resolveStudioWorkspaceSelection(projectId, null, [])).toEqual({
      selection: { kind: "agent-map", projectId },
      repair: false,
    });
  });

  it("restores only a valid agent inside this project", () => {
    const selection = { kind: "agent" as const, projectId, agentId: "agent_1" };
    expect(
      resolveStudioWorkspaceSelection(projectId, selection, ["agent_1"]),
    ).toEqual({
      selection,
      repair: false,
    });
    expect(resolveStudioWorkspaceSelection(projectId, selection, [])).toEqual({
      selection: { kind: "agent-map", projectId },
      repair: true,
    });
  });

  it("repairs a foreign-project selection", () => {
    expect(
      resolveStudioWorkspaceSelection(
        projectId,
        { kind: "agent-map", projectId: "project_foreign" },
        [],
      ),
    ).toEqual({ selection: { kind: "agent-map", projectId }, repair: true });
  });
});

describe("mostSpecificStudioScope", () => {
  it("chooses the nearest containing durable project, not the first parent", () => {
    const nestedProjectId = "project_00000000-0000-4000-8000-000000000002";
    expect(
      mostSpecificStudioScope(
        "/work/services/agent",
        [
          { workspaceKey: "parent", cwd: "/work", projectId },
          {
            workspaceKey: "nested",
            cwd: "/work/services",
            projectId: nestedProjectId,
          },
        ],
        [
          validResponseProject(projectId),
          validResponseProject(nestedProjectId),
        ],
      )?.projectId,
    ).toBe(nestedProjectId);
  });

  it("fails closed when two durable projects claim the same nearest root", () => {
    const otherProjectId = "project_00000000-0000-4000-8000-000000000002";

    expect(
      mostSpecificStudioScope(
        "/work/services/agent",
        [
          { workspaceKey: "scope-a", cwd: "/work/services", projectId },
          {
            workspaceKey: "scope-b",
            cwd: "/work/services",
            projectId: otherProjectId,
          },
        ],
        [validResponseProject(projectId), validResponseProject(otherProjectId)],
      ),
    ).toBeNull();
  });

  it("selects the most-specific binding of one Windows project across case variants", () => {
    expect(
      mostSpecificStudioScope(
        "c:/users/alice/project/PACKAGES/app/src",
        [
          {
            workspaceKey: "project-root",
            cwd: "C:\\Users\\Alice\\Project",
            projectId,
          },
          {
            workspaceKey: "packages-root",
            cwd: "C:\\Users\\Alice\\Project\\packages",
            projectId,
          },
          {
            workspaceKey: "sibling-project",
            cwd: "C:\\Users\\Alice\\Project-two",
            projectId: "project_00000000-0000-4000-8000-000000000003",
          },
        ],
        [validResponseProject(projectId)],
      )?.workspaceKey,
    ).toBe("packages-root");
  });

  it("resolves disjoint bindings of one durable project independently of scope order", () => {
    const scopes = [
      {
        workspaceKey: "research-root",
        cwd: "C:\\Projects\\Research",
        projectId,
      },
      {
        workspaceKey: "publisher-root",
        cwd: "D:\\Projects\\Publisher",
        projectId,
      },
    ];
    for (const ordered of [scopes, [...scopes].reverse()]) {
      expect(
        mostSpecificStudioScope("c:/projects/research/src", ordered, [
          validResponseProject(projectId),
        ])?.workspaceKey,
      ).toBe("research-root");
      expect(
        mostSpecificStudioScope("d:/projects/publisher/src", ordered, [
          validResponseProject(projectId),
        ])?.workspaceKey,
      ).toBe("publisher-root");
    }
  });
});

function validResponseProject(id: string): StudioProjectSummary {
  return {
    projectId: id,
    identityVersion: 1,
    displayName: "Project",
    bindings: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
