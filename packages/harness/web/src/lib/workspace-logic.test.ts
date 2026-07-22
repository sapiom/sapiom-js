/**
 * Unit coverage for the pure workspace logic the shell depends on —
 * fuzzy matching (command palette), workspace tree grouping (left rail),
 * and macro gating (action strip + canvas CTA).
 */
import { describe, expect, it } from "vitest";
import type { HarnessSession, MacroDef, WorkflowInfo } from "@shared/types";

import { fuzzyScore } from "./fuzzy";
import { buildWorkspaceTree } from "./workspace-tree";
import { findVisualizeMacro, macroDisabledReason } from "./macro-gating";

const session = (overrides: Partial<HarnessSession>): HarnessSession => ({
  id: "sess-1",
  agentSessionId: null,
  harness: "claude-code",
  cwd: "/home/dev/app",
  title: "app",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  boundWorkflowPath: null,
  ready: true,
  ...overrides,
});

const workflow = (overrides: Partial<WorkflowInfo>): WorkflowInfo => ({
  name: "leasing",
  path: "/home/dev/app/leasing",
  definitionId: null,
  source: "scan",
  ...overrides,
});

describe("fuzzyScore", () => {
  it("matches subsequences and prefers tighter matches", () => {
    const loose = fuzzyScore("lsg", "leasing");
    const exact = fuzzyScore("leasing", "leasing");
    expect(loose).not.toBeNull();
    expect(exact).not.toBeNull();
    expect(exact!).toBeGreaterThan(loose!);
  });

  it("returns null when characters are missing", () => {
    expect(fuzzyScore("xyz", "leasing")).toBeNull();
  });
});

describe("buildWorkspaceTree (explorer: folders > agents)", () => {
  it("files agents under the owning workspace folder with STABLE ordering; orphans stay separate", () => {
    const sessions = [
      session({ id: "a", cwd: "/home/dev/app", boundWorkflowPath: "/home/dev/app/leasing" }),
      session({ id: "b", cwd: "/home/dev/other", boundWorkflowPath: "/home/dev/other/rfq" }),
    ];
    const workflows = [
      workflow({ path: "/home/dev/app/leasing" }),
      workflow({ name: "rfq", path: "/home/dev/other/rfq" }),
      workflow({ name: "orphan", path: "/elsewhere/orphan" }),
    ];
    const tree = buildWorkspaceTree(workflows, sessions);
    // Ordering is stable (equal createdAt ties break by path), never reshuffled
    // by which agent is focused — a rail that jumps destroys spatial memory.
    expect(tree.workspaces.map((w) => w.cwd)).toEqual(["/home/dev/app", "/home/dev/other"]);
    expect(tree.workspaces[0]?.agents.map((a) => a.workflow.name)).toEqual(["leasing"]);
    // Sessions are NOT a rail concern: agent nodes carry no session attribute.
    expect(tree.workspaces[0]?.bareSessions).toEqual([]);
    expect(tree.orphanAgents.map((a) => a.workflow.name)).toEqual(["orphan"]);
  });

  it("files every agent under its longest-prefix folder, sessions or not", () => {
    // Two live sessions bound to the same agent — neither surfaces as a rail
    // row; the folder simply carries the one agent.
    const sessions = [
      session({
        id: "a",
        cwd: "/home/dev/app",
        boundWorkflowPath: "/home/dev/app/leasing",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      session({
        id: "b",
        cwd: "/home/dev/app",
        boundWorkflowPath: "/home/dev/app/leasing",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ];
    const tree = buildWorkspaceTree([workflow({ path: "/home/dev/app/leasing" })], sessions);
    expect(tree.workspaces.map((w) => w.cwd)).toEqual(["/home/dev/app"]);
    expect(tree.workspaces[0]?.agents.map((a) => a.workflow.name)).toEqual(["leasing"]);
    expect(tree.workspaces[0]?.bareSessions).toEqual([]);
  });

  it("a live unbound session in an agentless folder is a bare (focusable) folder", () => {
    const sessions = [session({ id: "bare", cwd: "/home/dev/scratch", boundWorkflowPath: null })];
    const tree = buildWorkspaceTree([], sessions);
    expect(tree.workspaces).toHaveLength(1);
    expect(tree.workspaces[0]?.agents).toEqual([]);
    expect(tree.workspaces[0]?.bareSessions.map((s) => s.id)).toEqual(["bare"]);
  });

  it("keeps a workspace for an exited session's directory when it owns an agent", () => {
    const sessions = [
      session({ id: "x", cwd: "/home/dev/rfq", status: "exited", boundWorkflowPath: null }),
    ];
    const tree = buildWorkspaceTree([workflow({ name: "rfq", path: "/home/dev/rfq" })], sessions);
    expect(tree.workspaces.map((w) => w.cwd)).toEqual(["/home/dev/rfq"]);
    expect(tree.workspaces[0]?.agents.map((a) => a.workflow.name)).toEqual(["rfq"]);
    // The exited session is not live, so it never becomes a bare folder row.
    expect(tree.workspaces[0]?.bareSessions).toEqual([]);
  });

  it("drops a folder with no agents and no live sessions (nothing to show)", () => {
    const sessions = [session({ id: "x", cwd: "/home/dev/gone", status: "exited", boundWorkflowPath: null })];
    const tree = buildWorkspaceTree([], sessions);
    expect(tree.workspaces).toEqual([]);
  });
});

describe("macro gating", () => {
  const macros: MacroDef[] = [
    { id: "visualize", label: "Visualize", icon: "Sparkles", action: { kind: "render-canvas" } },
    {
      id: "deploy",
      label: "Deploy",
      icon: "Rocket",
      action: { kind: "inject", text: "deploy {{workflow.path}}" },
      requiresWorkflow: true,
    },
    {
      id: "open_prod",
      label: "Open",
      icon: "ExternalLink",
      action: { kind: "open-url", url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}" },
      requiresWorkflow: true,
    },
  ];

  it("finds the visualize macro by action kind", () => {
    expect(findVisualizeMacro(macros)?.id).toBe("visualize");
  });

  it("requires a session before anything runs", () => {
    expect(macroDisabledReason(macros[0], null, null)).toBe("Start a session first");
  });

  it("requires a selected workflow for requiresWorkflow macros", () => {
    expect(macroDisabledReason(macros[1], null, "sess-1")).toBe("Select a workflow first");
  });

  it("blocks definitionId-dependent macros until deployed", () => {
    const undeployed = workflow({ definitionId: null });
    const deployed = workflow({ definitionId: 42 });
    expect(macroDisabledReason(macros[2], undeployed, "sess-1")).toBe("Not deployed yet");
    expect(macroDisabledReason(macros[2], deployed, "sess-1")).toBeNull();
  });
});
