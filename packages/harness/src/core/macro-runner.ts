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

const PLACEHOLDER_PATTERN = /\{\{[a-zA-Z.]+\}\}/g;

interface PlaceholderEntry {
  /** False when the context has no real value for this token (e.g. no
   *  workflow selected, or an empty subject) — substituting it anyway would
   *  silently inject a broken prompt/URL. */
  available: boolean;
  value: string;
}

function placeholderTable(ctx: MacroContext): Record<string, PlaceholderEntry> {
  return {
    "{{workflow.path}}": { available: ctx.workflow != null, value: ctx.workflow?.path ?? "" },
    "{{workflow.name}}": { available: ctx.workflow != null, value: ctx.workflow?.name ?? "" },
    "{{workflow.definitionId}}": {
      available: ctx.workflow?.definitionId != null,
      value: ctx.workflow?.definitionId != null ? String(ctx.workflow.definitionId) : "",
    },
    "{{session.cwd}}": { available: true, value: ctx.sessionCwd },
    "{{canvas.path}}": { available: true, value: ctx.canvasPath },
    "{{subject}}": { available: Boolean(ctx.subject), value: ctx.subject ?? "" },
  };
}

/**
 * Substitutes every known `{{...}}` placeholder found in `template`. Throws
 * `MacroValidationError` listing every placeholder that's present in the
 * template but has no value in `ctx` — instead of silently injecting text
 * with a hole in it (e.g. "visualize  to .sapiom/canvas/index.html" with no
 * subject). An unrecognized `{{...}}`-shaped token is left verbatim; it's not
 * a placeholder this engine knows about.
 */
function substitute(template: string, ctx: MacroContext): string {
  const table = placeholderTable(ctx);
  const missing: string[] = [];

  const result = template.replace(PLACEHOLDER_PATTERN, (token) => {
    const entry = table[token];
    if (!entry) return token;
    if (!entry.available) missing.push(token);
    return entry.value;
  });

  if (missing.length > 0) {
    throw new MacroValidationError(`Missing values for: ${missing.join(", ")}`);
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
