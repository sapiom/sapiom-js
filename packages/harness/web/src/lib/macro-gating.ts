import type { MacroDef, WorkflowInfo } from "@shared/types";

/** The macro that renders the bound workflow onto the canvas — surfaced as its own CTA in the canvas empty state. */
export function findVisualizeMacro(macros: MacroDef[]): MacroDef | undefined {
  return macros.find((macro) => macro.id === "visualize");
}

/** Shared gating logic for any surface that runs a macro against a specific workflow (the docked action strip, the canvas empty-state CTA). */
export function macroDisabledReason(
  macro: MacroDef,
  workflow: WorkflowInfo | null,
  activeSessionId: string | null,
): string | null {
  if (macro.requiresWorkflow) {
    if (!workflow) return "Select a workflow first";
    if (
      macro.action.kind === "open-url" &&
      macro.action.url.includes("{{workflow.definitionId}}") &&
      workflow.definitionId == null
    ) {
      return "Not deployed yet";
    }
  }
  // Both "inject" (types into the pty) and "render-canvas" (the deterministic
  // Visualize path) need a real session to act against — only "open-url" doesn't.
  if (macro.action.kind !== "open-url" && !activeSessionId) return "Start a session first";
  return null;
}

export function resolveMacroUrl(url: string, workflow: WorkflowInfo | null): string {
  return url.replace("{{workflow.definitionId}}", String(workflow?.definitionId ?? ""));
}
