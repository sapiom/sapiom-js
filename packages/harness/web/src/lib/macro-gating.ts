import type { MacroDef, WorkflowInfo } from "@shared/types";

/** The macro that renders the bound workflow onto the canvas — surfaced as its own CTA in the canvas empty state. */
export function findVisualizeMacro(macros: MacroDef[]): MacroDef | undefined {
  return macros.find((macro) => macro.id === "visualize");
}

/** Shared gating logic for any surface that runs a macro against a specific workflow (the docked action strip, the canvas empty-state CTA). */
/**
 * No reason names a session: agent verbs are addressed by the agent's path,
 * never by a session (flow-map-chat-overlay.md 4.4b). The "Start a session
 * first" gate this replaced disabled Visualize and every inject macro on any
 * surface with no live session beside it.
 */
export function macroDisabledReason(
  macro: MacroDef,
  workflow: WorkflowInfo | null,
): string | null {
  if (macro.requiresWorkflow) {
    if (!workflow) return "Select an agent first";
    if (
      macro.action.kind === "open-url" &&
      macro.action.url.includes("{{workflow.definitionId}}") &&
      workflow.definitionId == null
    ) {
      return "Not deployed yet";
    }
  }
  return null;
}

export function resolveMacroUrl(url: string, workflow: WorkflowInfo | null): string {
  return url.replace("{{workflow.definitionId}}", String(workflow?.definitionId ?? ""));
}
