/**
 * Unit coverage for the pure shell logic that has no home of its own — fuzzy
 * matching (command palette) and macro gating (action strip + canvas CTA).
 *
 * The `buildWorkspaceTree` blocks that used to sit between them are gone with
 * the module they tested (SAP-2932 finished SAP-2928's retirement): the
 * Workspace axis accumulated a row for every directory that had ever hosted a
 * session, and `project-tree.ts` — with `project-tree.test.ts` beside it —
 * replaced both it and the Deployment axis.
 */
import { describe, expect, it } from "vitest";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { fuzzyScore } from "./fuzzy";
import { findVisualizeMacro, macroDisabledReason } from "./macro-gating";

const workflow = (overrides: Partial<WorkflowInfo>): WorkflowInfo => ({
  name: "leasing",
  path: "/home/dev/app/leasing",
  definitionId: null,
  definitionSlug: null,
  source: "scan",
  ...overrides,
});

// The matcher's own behavior (boundary gating, scoring order, the Slack
// regressions) is pinned in fuzzy.test.ts — this keeps only the palette-visible
// contract this file always asserted: tighter matches rank higher, absent
// characters don't match at all.
describe("fuzzyScore", () => {
  it("prefers tighter matches", () => {
    const loose = fuzzyScore("leas", "leasing");
    const exact = fuzzyScore("leasing", "leasing");
    expect(loose).not.toBeNull();
    expect(exact).not.toBeNull();
    expect(exact!).toBeGreaterThan(loose!);
  });

  it("returns null when characters are missing", () => {
    expect(fuzzyScore("xyz", "leasing")).toBeNull();
  });

  it("no longer accepts off-boundary scatter (the old matcher did)", () => {
    expect(fuzzyScore("lsg", "leasing")).toBeNull();
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
      action: { kind: "open-url", url: "https://app.sapiom.ai/agents/{{workflow.definitionId}}" },
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
    expect(macroDisabledReason(macros[1], null, "sess-1")).toBe("Select an agent first");
  });

  it("blocks definitionId-dependent macros until deployed", () => {
    const undeployed = workflow({ definitionId: null });
    const deployed = workflow({ definitionId: 42 });
    expect(macroDisabledReason(macros[2], undeployed, "sess-1")).toBe("Not deployed yet");
    expect(macroDisabledReason(macros[2], deployed, "sess-1")).toBeNull();
  });
});
