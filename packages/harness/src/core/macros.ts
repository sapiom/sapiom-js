/**
 * Default action-rail macros. Pure data — no execution wiring. The server
 * resolves `{{...}}` placeholders (see MacroDef in shared/types.ts) and
 * either injects the text into the session pty or opens the URL. Matches the
 * SPA's MOCK_MACROS fixture (web/src/lib/mock-data.ts) so mock and real mode
 * present the same action rail.
 */
import type { MacroDef } from "../shared/types.js";

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
    // One-click render/re-render, unbound-friendly again: the canvas kit
    // (core/canvas-template.ts) has already dropped a prebuilt template with
    // correct CSS + a renderer into {{canvas.path}} — the only thing this
    // macro ever asks an agent to write is the small JSON data block the
    // renderer reads, never raw HTML. No free-text subject and no
    // {{workflow.path}} reference: whether there's a bound workflow is
    // something the agent reads out of harness-context.json at run time, so
    // the same static prompt works whether or not one is selected.
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    requiresWorkflow: false,
    action: {
      kind: "inject",
      submit: true,
      text: `Open {{canvas.path}} and find the <script type="application/json" id="canvas-data"> block — the comment directly above it documents the schema. Update ONLY that JSON: read .sapiom/harness-context.json first — if it has a boundWorkflow, represent that workflow's steps, control flow, and terminal outcomes as one graph; if boundWorkflow is null, represent every workflow in its workflows list as its own graph, plus interconnections showing how they hand off or signal to each other. Leave every other byte of the file exactly as it is — the CSS and the renderer script are already correct; do not touch them.`,
    },
  },
];
