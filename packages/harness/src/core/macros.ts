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
    execution: "inject",
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
    execution: "inject",
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
    execution: "inject",
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
    // Not "inject"/"background" (that axis is about where an "inject"
    // macro's text runs) — open-url has no session-side execution at all,
    // this is just the required field's least-wrong value for it.
    execution: "inject",
    action: {
      kind: "open-url",
      url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}",
    },
  },
  {
    // One-click render/re-render, unbound-friendly: the canvas kit
    // (core/canvas-template.ts) has already dropped a prebuilt, pristine
    // _template.html plus a live index.html into .sapiom/canvas/ — the
    // agent clones the template and fills it in with real markup, using the
    // classes/patterns the template documents, rather than hand-rolling CSS
    // or a whole document from scratch. No free-text subject and no
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
      text: `Clone .sapiom/canvas/_template.html to .sapiom/canvas/index.html (overwrite it — that's {{canvas.path}}), keeping the <style> block and every structural/pattern class untouched. Do not write new CSS. Then fill in the content: title, badges, subtitle, and stats values, and build the SVG graph using the template's node/edge markup patterns — see the <template id="canvas-patterns"> block in the cloned file for one example of each, and delete that block once you've copied what you need. Read .sapiom/harness-context.json first: if it has a boundWorkflow, draw that workflow's steps, control flow, and terminal outcomes; if boundWorkflow is null, draw one canvas-panel per workflow in its workflows list, plus an Interconnections panel showing how they hand off or signal to each other.`,
    },
  },
];
