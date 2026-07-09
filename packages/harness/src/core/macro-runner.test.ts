import { describe, it, expect } from "vitest";
import { resolveMacro, MacroValidationError, type MacroContext } from "./macro-runner.js";
import type { MacroDef, WorkflowInfo } from "../shared/types.js";

const workflow: WorkflowInfo = {
  name: "leasing",
  path: "/Users/demo/acme-app/leasing",
  definitionId: 4821,
  source: "scan",
};

const baseCtx: MacroContext = {
  workflow,
  sessionCwd: "/Users/demo/acme-app",
  canvasPath: "/Users/demo/acme-app/.sapiom/canvas/index.html",
  subject: "the leasing funnel",
};

describe("resolveMacro", () => {
  it("substitutes all documented placeholders in an inject macro", () => {
    const macro: MacroDef = {
      id: "kitchen-sink",
      label: "Kitchen sink",
      icon: "Sparkles",
      action: {
        kind: "inject",
        text: "{{workflow.path}} {{workflow.name}} {{workflow.definitionId}} {{session.cwd}} {{canvas.path}} {{subject}}",
      },
    };

    const resolved = resolveMacro(macro, baseCtx);
    expect(resolved).toEqual({
      kind: "inject",
      text: "/Users/demo/acme-app/leasing leasing 4821 /Users/demo/acme-app /Users/demo/acme-app/.sapiom/canvas/index.html the leasing funnel",
      submit: true,
    });
  });

  it("defaults submit to true when the macro omits it, and honors submit:false", () => {
    const macro: MacroDef = {
      id: "no-submit",
      label: "No submit",
      icon: "Play",
      action: { kind: "inject", text: "hi", submit: false },
    };
    expect(resolveMacro(macro, baseCtx)).toEqual({ kind: "inject", text: "hi", submit: false });
  });

  it("substitutes placeholders in an open-url macro", () => {
    const macro: MacroDef = {
      id: "open",
      label: "Open",
      icon: "ExternalLink",
      action: { kind: "open-url", url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}" },
    };
    expect(resolveMacro(macro, baseCtx)).toEqual({
      kind: "open-url",
      url: "https://app.sapiom.ai/workflows/4821",
    });
  });

  it("throws MacroValidationError listing every missing placeholder, rather than injecting a hole", () => {
    const macro: MacroDef = {
      id: "visualize",
      label: "Visualize",
      icon: "Sparkles",
      action: { kind: "inject", text: "path=[{{workflow.path}}] id=[{{workflow.definitionId}}]" },
    };
    expect(() => resolveMacro(macro, { ...baseCtx, workflow: null })).toThrow(
      "Missing values for: {{workflow.path}}, {{workflow.definitionId}}",
    );
  });

  it("throws MacroValidationError when requiresWorkflow and no workflow is selected", () => {
    const macro: MacroDef = {
      id: "deploy",
      label: "Deploy",
      icon: "Cloud",
      requiresWorkflow: true,
      action: { kind: "inject", text: "cd {{workflow.path}} && sapiom agents deploy" },
    };
    expect(() => resolveMacro(macro, { ...baseCtx, workflow: null })).toThrow(MacroValidationError);
    expect(() => resolveMacro(macro, { ...baseCtx, workflow: null })).toThrow(
      "requires a selected workflow",
    );
  });

  it("does not require a workflow when requiresWorkflow is falsy and the template doesn't reference one", () => {
    const macro: MacroDef = {
      id: "visualize",
      label: "Visualize",
      icon: "Sparkles",
      action: { kind: "inject", text: "visualize {{subject}}" },
    };
    expect(resolveMacro(macro, { ...baseCtx, workflow: null })).toEqual({
      kind: "inject",
      text: "visualize the leasing funnel",
      submit: true,
    });
  });

  it("throws MacroValidationError when subject is referenced but not provided", () => {
    const macro: MacroDef = {
      id: "visualize",
      label: "Visualize",
      icon: "Sparkles",
      action: { kind: "inject", text: "visualize {{subject}}" },
    };
    expect(() => resolveMacro(macro, { ...baseCtx, subject: undefined })).toThrow(
      "Missing values for: {{subject}}",
    );
  });

  it("leaves an unrecognized {{...}}-shaped token verbatim", () => {
    const macro: MacroDef = {
      id: "custom",
      label: "Custom",
      icon: "Sparkles",
      action: { kind: "inject", text: "note: {{not.a.real.placeholder}}" },
    };
    expect(resolveMacro(macro, baseCtx)).toEqual({
      kind: "inject",
      text: "note: {{not.a.real.placeholder}}",
      submit: true,
    });
  });
});
