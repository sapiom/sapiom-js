import { describe, expect, it } from "vitest";

import { parseAgentMapWorkspaceResponse } from "./agent-map";
import { MockApi } from "./api";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-01T12:00:00.000Z";

function validResponse(): unknown {
  return {
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
