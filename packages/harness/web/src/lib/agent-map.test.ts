import { describe, expect, it } from "vitest";
import type { StudioProjectSummary } from "@sapiom/agent-map";

import {
  mostSpecificStudioScope,
  studioScopeForAgent,
  resolveStudioWorkspaceSelection,
} from "./agent-map";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-01T12:00:00.000Z";

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
  it("resolves an explicitly bound sibling through its project without broadening the root", () => {
    const scopes = [
      { workspaceKey: "original", cwd: "/projects/original", projectId },
    ];
    const workflow = {
      path: "/projects/reviewer",
      studioBindings: [{ projectId, agentId: "agent-a" }],
    };
    expect(
      studioScopeForAgent(workflow, scopes, [validResponseProject(projectId)]),
    ).toEqual(scopes[0]);
    expect(studioScopeForAgent(workflow, scopes, [])).toBeNull();
    expect(
      studioScopeForAgent(
        workflow,
        scopes,
        [validResponseProject(projectId)],
        "foreign-project",
      ),
    ).toBeNull();
    expect(
      studioScopeForAgent({ path: workflow.path }, scopes, [
        validResponseProject(projectId),
      ]),
    ).toBeNull();
  });

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
