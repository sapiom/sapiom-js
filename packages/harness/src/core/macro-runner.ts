/**
 * Macro resolution (workstream W5's backend slice): substitutes the
 * `{{...}}` placeholders documented on MacroDef (shared/types.ts) into a
 * macro's action, given the run-time context (selected workflow, session,
 * canvas path, free-text subject). Pure and side-effect free — the caller
 * (src/server/macros.ts) executes the resolved action.
 */
import type { MacroDef, WorkflowInfo } from "../shared/types.js";

export interface MacroContext {
  workflow: WorkflowInfo | null;
  sessionCwd: string;
  /** Absolute path to the session's canvas index file ({{canvas.path}}). */
  canvasPath: string;
  /** Free-text subject for the Visualize macro ({{subject}}). */
  subject?: string;
}

export type ResolvedMacroAction =
  | { kind: "inject"; text: string; submit: boolean }
  | { kind: "open-url"; url: string };

export class MacroValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacroValidationError";
  }
}

// Target lib is ES2020 (see the root tsconfig) — no String.prototype.replaceAll.
function replaceAllLiteral(input: string, search: string, replacement: string): string {
  return input.split(search).join(replacement);
}

function substitute(template: string, ctx: MacroContext): string {
  const replacements: Record<string, string> = {
    "{{workflow.path}}": ctx.workflow?.path ?? "",
    "{{workflow.name}}": ctx.workflow?.name ?? "",
    "{{workflow.definitionId}}":
      ctx.workflow?.definitionId != null ? String(ctx.workflow.definitionId) : "",
    "{{session.cwd}}": ctx.sessionCwd,
    "{{canvas.path}}": ctx.canvasPath,
    "{{subject}}": ctx.subject ?? "",
  };

  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = replaceAllLiteral(result, placeholder, value);
  }
  return result;
}

/**
 * Resolves a macro's action for execution against `ctx`.
 * Throws `MacroValidationError` when `macro.requiresWorkflow` and `ctx.workflow`
 * is null — the caller (the REST handler) turns that into a 400.
 */
export function resolveMacro(macro: MacroDef, ctx: MacroContext): ResolvedMacroAction {
  if (macro.requiresWorkflow && !ctx.workflow) {
    throw new MacroValidationError(`Macro '${macro.id}' requires a selected workflow.`);
  }

  if (macro.action.kind === "open-url") {
    return { kind: "open-url", url: substitute(macro.action.url, ctx) };
  }

  return {
    kind: "inject",
    text: substitute(macro.action.text, ctx),
    submit: macro.action.submit ?? true,
  };
}
