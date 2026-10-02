import { describe, expect, it } from "vitest";

import type { AgentMapWorkspaceState } from "@sapiom/agent-map";
import type { HarnessSession } from "../shared/types.js";
import {
  buildFocusedProjectContext,
  isProjectSessionDispatchAuthorized,
  isWithinCurrentProject,
} from "./project-session.js";
import type { StudioProjectIdentity } from "@sapiom/agent-map/node/studio-project-catalog";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const projectRoot = "/Users/private/customer-secret-project";
const project: StudioProjectIdentity = {
  projectId,
  identityVersion: 1,
  displayName: "Private research",
  rootBindings: [{
    id: "root_00000000-0000-4000-8000-000000000001",
    repositoryId: "repo-private",
    localRootRef: projectRoot,
    status: "active",
  }],
  legacyWorkspaceKeys: ["private-workspace-key"],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const workspace: AgentMapWorkspaceState = {
  projectId,
  schemaVersion: 1,
  recordVersion: 1,
  confirmedRevisionId: null,
  activeProposalId: null,
  projectBuildPlanId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function session(id: string): HarnessSession {
  return {
    id,
    agentSessionId: null,
    harness: "codex",
    cwd: projectRoot,
    title: "Ordinary session",
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActiveAt: "2026-09-01T00:00:00.000Z",
    exitCode: null,
    boundWorkflowPath: null,
    ready: false,
    agentMapIdentity: { projectId, sessionId: id, userId: "user-1" },
  };
}

describe("role-neutral project session", () => {
  it("accepts only active project roots and their descendants", () => {
    const withMissingBinding: StudioProjectIdentity = {
      ...project,
      rootBindings: [
        ...project.rootBindings,
        {
          id: "root_00000000-0000-4000-8000-000000000002",
          repositoryId: null,
          localRootRef: "/Users/private/inactive",
          status: "missing",
        },
      ],
    };
    expect(isWithinCurrentProject(project, projectRoot)).toBe(true);
    expect(isWithinCurrentProject(project, `${projectRoot}/agents/research`)).toBe(true);
    expect(isWithinCurrentProject(project, `${projectRoot}-old`)).toBe(false);
    expect(isWithinCurrentProject(project, "/Users/private")).toBe(false);
    expect(
      isWithinCurrentProject(
        withMissingBinding,
        "/Users/private/inactive/agent",
      ),
    ).toBe(false);
  });

  it("normalizes Windows separators without mixing path families", () => {
    const windowsProject: StudioProjectIdentity = {
      ...project,
      rootBindings: [
        {
          ...project.rootBindings[0]!,
          localRootRef: "C:\\Users\\private\\project",
        },
      ],
    };

    expect(
      isWithinCurrentProject(
        windowsProject,
        "C:/Users/private/project/agents/research",
      ),
    ).toBe(true);
    expect(
      isWithinCurrentProject(
        windowsProject,
        "/Users/private/project/agents/research",
      ),
    ).toBe(false);
  });

  it("authorizes a scoped session regardless of attribution", async () => {
    const ordinary = session("ordinary");
    await expect(isProjectSessionDispatchAuthorized({
      session: ordinary,
      resolveProject: async () => project,
    })).resolves.toBe(true);
    ordinary.agentMapIdentity = {
      projectId,
      sessionId: ordinary.id,
      userId: "previous-account",
    };
    await expect(isProjectSessionDispatchAuthorized({
      session: ordinary,
      resolveProject: async () => project,
    })).resolves.toBe(true);
  });

  it("rechecks project and session identity after project lookup", async () => {
    const ordinary = session("race");
    let resolve!: (value: StudioProjectIdentity | null) => void;
    const authorization = isProjectSessionDispatchAuthorized({
      session: ordinary,
      resolveProject: () => new Promise((done) => { resolve = done; }),
    });
    await Promise.resolve();
    ordinary.agentMapIdentity = {
      projectId: "different-project",
      sessionId: ordinary.id,
      userId: "user-2",
    };
    resolve(project);
    await expect(authorization).resolves.toBe(false);
  });

  it("builds bounded path-free context without changing authority", () => {
    const context = buildFocusedProjectContext({
      project,
      workspace,
      sessionId: "session-1",
      userId: "user-1",
      details: { warnings: Array.from({ length: 40 }, (_, i) => `warning-${i}-${"w".repeat(400)}`) },
    });
    const parsed = JSON.parse(context.split("\n")[2]!) as {
      identity: Record<string, string>;
      project: { warnings: string[] };
    };
    expect(parsed.identity).toEqual({ projectId, sessionId: "session-1", userId: "user-1" });
    expect(parsed.project.warnings).toHaveLength(16);
    expect(context).not.toContain('"role"');
    expect(context).not.toContain(projectRoot);
    expect(context).not.toContain("private-workspace-key");
    expect(context.length).toBeLessThan(16_384);
  });
});
