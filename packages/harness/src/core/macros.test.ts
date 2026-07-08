import { describe, it, expect } from "vitest";
import { DEFAULT_MACROS } from "./macros.js";

describe("DEFAULT_MACROS", () => {
  it("defines exactly the 6 action-rail macros, matching the SPA's MOCK_MACROS ids", () => {
    expect(DEFAULT_MACROS.map((m) => m.id)).toEqual([
      "run_local",
      "deploy",
      "prod_run",
      "open_prod",
      "visualize",
      "ai-visualize",
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

  it("visualize is a one-click, unbound-friendly deterministic render — no LLM, no pty involved", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "visualize")!;
    // Works whether or not a workflow is bound — the render pipeline reads
    // the session's actual binding server-side, so there's no prompt text
    // (and therefore no {{workflow.path}} to throw on when unbound).
    expect(macro.requiresWorkflow).toBeFalsy();
    expect(macro.action).toEqual({ kind: "render-canvas" });
  });

  it("ai-visualize is the LLM fallback — same unbound-friendly template-clone prompt visualize used to run", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "ai-visualize")!;
    expect(macro.requiresWorkflow).toBeFalsy();
    expect(macro.action.kind).toBe("inject");
    if (macro.action.kind === "inject") {
      expect(macro.action.text).toContain("{{canvas.path}}");
      expect(macro.action.text).not.toContain("{{workflow.path}}");
      expect(macro.action.text).not.toContain("{{subject}}");
      // Clone-and-fill, not a JSON data edit and not "write HTML from
      // scratch" — the whole point of the template-clone canvas kit.
      expect(macro.action.text).toMatch(/_template\.html/);
      expect(macro.action.text).toMatch(/canvas-patterns/);
      expect(macro.action.text).toMatch(/harness-context\.json/);
      expect(macro.action.text).toMatch(/do not write new css/i);
    }
  });

  it("every macro has a non-empty label and icon", () => {
    for (const macro of DEFAULT_MACROS) {
      expect(macro.label.length).toBeGreaterThan(0);
      expect(macro.icon.length).toBeGreaterThan(0);
    }
  });
});
