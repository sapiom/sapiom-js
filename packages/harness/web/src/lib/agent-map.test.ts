import { describe, expect, it } from "vitest";
import type { StudioProjectSummary } from "@shared/agent-map";

import {
  mostSpecificStudioScope,
  parseAgentMapWorkspaceResponse,
  resolveStudioWorkspaceSelection,
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
