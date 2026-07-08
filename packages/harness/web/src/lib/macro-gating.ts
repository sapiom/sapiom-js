import type { MacroDef, WorkflowInfo } from "@shared/types";

/** Macros carrying a `{{subject}}` placeholder prompt for free text before running (only Visualize today). */
export function needsSubject(macro: MacroDef): boolean {
  return macro.action.kind === "inject" && macro.action.text.includes("{{subject}}");
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
