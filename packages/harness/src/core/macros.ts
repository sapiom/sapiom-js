/**
 * Default action-rail macros. Pure data — no execution wiring. The server
 * resolves `{{...}}` placeholders (see MacroDef in shared/types.ts) and
 * either injects the text into the session pty or opens the URL. Matches the
 * SPA's MOCK_MACROS fixture (web/src/lib/mock-data.ts) so mock and real mode
 * present the same action rail.
 */
import type { MacroDef } from "../shared/types.js";
import { CANVAS_STYLE_GUIDELINES } from "../profiles/canvas-guidelines.js";

export const DEFAULT_MACROS: MacroDef[] = [
  {
    id: "run_local",
    label: "Run local",
    icon: "Play",
    requiresWorkflow: true,
    action: {
      kind: "inject",
      submit: true,
      text: "cd {{workflow.path}} && sapiom agents run --target local",
    },
  },
  {
    id: "deploy",
    label: "Deploy",
    icon: "Cloud",
    requiresWorkflow: true,
    action: {
      kind: "inject",
      submit: true,
      text: "cd {{workflow.path}} && sapiom agents deploy",
    },
  },
  {
    id: "prod_run",
    label: "Prod run",
    icon: "Zap",
    requiresWorkflow: true,
    action: {
      kind: "inject",
      submit: true,
      text: "cd {{workflow.path}} && sapiom agents run --target prod",
    },
  },
  {
    id: "open_prod",
    label: "Open prod",
    icon: "ExternalLink",
    requiresWorkflow: true,
    action: {
      kind: "open-url",
      url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}",
    },
  },
  {
    // One-click render/re-render of the bound workflow — no free-text
    // subject: the workflow, its path, and the rest of the workspace (for
    // "how it interconnects") are all already known from context, so this
    // is a fully self-sufficient prompt with nothing for the user to fill in.
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    requiresWorkflow: true,
    action: {
      kind: "inject",
      submit: true,
      text: `Render (or re-render, overwriting {{canvas.path}}) a visualization of the workflow at {{workflow.path}} — its steps, control flow, and how it interconnects with the other workflows in this workspace (see .sapiom/harness-context.json for the full list). Follow these guidelines:\n\n${CANVAS_STYLE_GUIDELINES}`,
    },
  },
];
