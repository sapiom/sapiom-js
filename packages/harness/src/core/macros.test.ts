import { describe, it, expect } from "vitest";
import { DEFAULT_MACROS } from "./macros.js";

describe("DEFAULT_MACROS", () => {
  it("defines exactly the 5 action-rail macros, matching the SPA's MOCK_MACROS ids", () => {
    expect(DEFAULT_MACROS.map((m) => m.id)).toEqual([
      "run_local",
      "deploy",
      "prod_run",
      "open_prod",
      "visualize",
    ]);
  });

  it("run_local, deploy, and prod_run require a selected workflow and template {{workflow.path}}", () => {
    for (const id of ["run_local", "deploy", "prod_run"]) {
      const macro = DEFAULT_MACROS.find((m) => m.id === id)!;
      expect(macro.requiresWorkflow).toBe(true);
      expect(macro.action.kind).toBe("inject");
      if (macro.action.kind === "inject") {
        expect(macro.action.text).toContain("{{workflow.path}}");
      }
    }
  });

  it("open_prod deep-links to the workflow and requires one to be selected", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "open_prod")!;
    expect(macro.requiresWorkflow).toBe(true);
    expect(macro.action).toEqual({
      kind: "open-url",
      url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}",
    });
  });

  it("visualize is a one-click, unbound-friendly data-only edit — no free-text subject, no workflow required", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "visualize")!;
    // Works whether or not a workflow is bound — the agent reads
    // harness-context.json at run time to decide single-workflow vs.
    // workspace-overview mode, so the static prompt can't reference
    // {{workflow.path}} (it'd throw when unbound).
    expect(macro.requiresWorkflow).toBeFalsy();
    expect(macro.action.kind).toBe("inject");
    if (macro.action.kind === "inject") {
      expect(macro.action.text).toContain("{{canvas.path}}");
      expect(macro.action.text).not.toContain("{{workflow.path}}");
      expect(macro.action.text).not.toContain("{{subject}}");
      // Data-only edit, not "write HTML" — the whole point of the canvas kit.
      expect(macro.action.text).toMatch(/canvas-data/);
      expect(macro.action.text).toMatch(/harness-context\.json/);
    }
  });

  it("every macro has a non-empty label and icon", () => {
    for (const macro of DEFAULT_MACROS) {
      expect(macro.label.length).toBeGreaterThan(0);
      expect(macro.icon.length).toBeGreaterThan(0);
    }
  });
});
