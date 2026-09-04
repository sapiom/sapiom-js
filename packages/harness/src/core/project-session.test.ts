import { describe, expect, it } from "vitest";

import type { AgentMapWorkspaceState } from "../shared/agent-map.js";
import type { HarnessSession } from "../shared/types.js";
import {
  buildFocusedProjectContext,
  isProjectSessionDispatchAuthorized,
  isWithinCurrentProject,
  localProjectPrincipal,
} from "./project-session.js";
import type { StudioProjectIdentity } from "./studio-project-catalog.js";

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
  it("uses the authenticated user or a stable machine-local principal", () => {
    expect(localProjectPrincipal("user-1", "machine-1")).toBe("user-1");
    expect(localProjectPrincipal(null, "machine-1")).toBe("local:machine-1");
  });

  it("accepts only active project roots and their descendants", () => {
    expect(isWithinCurrentProject(project, projectRoot)).toBe(true);
    expect(isWithinCurrentProject(project, `${projectRoot}/agents/research`)).toBe(true);
    expect(isWithinCurrentProject(project, `${projectRoot}-old`)).toBe(false);
    expect(isWithinCurrentProject(project, "/Users/private")).toBe(false);
  });

  it("authorizes only the exact neutral principal inside its project", async () => {
    const ordinary = session("ordinary");
    await expect(isProjectSessionDispatchAuthorized({
      session: ordinary,
      currentPrincipal: () => "user-1",
      resolveProject: async () => project,
    })).resolves.toBe(true);
    await expect(isProjectSessionDispatchAuthorized({
      session: ordinary,
      currentPrincipal: () => "user-2",
      resolveProject: async () => project,
    })).resolves.toBe(false);
  });

  it("rechecks principal and session identity after project lookup", async () => {
    let userId = "user-1";
    const ordinary = session("race");
    let resolve!: (value: StudioProjectIdentity | null) => void;
    const authorization = isProjectSessionDispatchAuthorized({
      session: ordinary,
      currentPrincipal: () => userId,
      resolveProject: () => new Promise((done) => { resolve = done; }),
    });
    await Promise.resolve();
    userId = "user-2";
    ordinary.agentMapIdentity = { projectId, sessionId: ordinary.id, userId };
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
