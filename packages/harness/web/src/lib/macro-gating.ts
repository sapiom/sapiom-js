import type { MacroDef, WorkflowInfo } from "@shared/types";

/**
 * The macro that renders the bound workflow onto the canvas — surfaced as
 * its own CTA in the canvas empty state, and kept out of the per-row quick
 * actions (see WorkflowsRail) since it needs the header's "bound" context,
 * not just any row you happen to be hovering.
 */
export function findVisualizeMacro(macros: MacroDef[]): MacroDef | undefined {
  return macros.find((macro) => macro.id === "visualize");
}

export function isVisualizeMacro(macro: MacroDef): boolean {
  return macro.id === "visualize";
}

/** Shared gating logic for any surface that runs a macro against a specific workflow (row actions, the bound-workflow header). */
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
  if (macro.action.kind === "inject" && !activeSessionId) return "Start a session first";
  return null;
}

export function resolveMacroUrl(url: string, workflow: WorkflowInfo | null): string {
  return url.replace("{{workflow.definitionId}}", String(workflow?.definitionId ?? ""));
}
