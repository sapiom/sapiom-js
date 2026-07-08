import { describe, it, expect } from "vitest";
import { DEFAULT_MACROS } from "./macros.js";

describe("DEFAULT_MACROS", () => {
  it("defines exactly the 5 action-rail macros", () => {
    expect(DEFAULT_MACROS.map((m) => m.id)).toEqual([
      "run-local",
      "deploy",
      "prod-run",
      "open-prod",
      "visualize",
    ]);
  });

  it("run-local, deploy, and prod-run require a selected workflow and template {{workflow.path}}", () => {
    for (const id of ["run-local", "deploy", "prod-run"]) {
      const macro = DEFAULT_MACROS.find((m) => m.id === id)!;
      expect(macro.requiresWorkflow).toBe(true);
      expect(macro.action.kind).toBe("inject");
      if (macro.action.kind === "inject") {
        expect(macro.action.text).toContain("{{workflow.path}}");
      }
    }
  });

  it("open-prod opens the app URL and needs no workflow", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "open-prod")!;
    expect(macro.requiresWorkflow).toBeFalsy();
    expect(macro.action).toEqual({ kind: "open-url", url: "https://app.sapiom.ai" });
  });

  it("visualize templates {{subject}} and {{canvas.path}}", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "visualize")!;
    expect(macro.action.kind).toBe("inject");
    if (macro.action.kind === "inject") {
      expect(macro.action.text).toContain("{{subject}}");
      expect(macro.action.text).toContain("{{canvas.path}}");
    }
  });

  it("every macro has a non-empty label and icon", () => {
    for (const macro of DEFAULT_MACROS) {
      expect(macro.label.length).toBeGreaterThan(0);
      expect(macro.icon.length).toBeGreaterThan(0);
    }
  });
});
