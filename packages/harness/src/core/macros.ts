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
    // One-click render/re-render, unbound-friendly: runs the deterministic,
    // zero-LLM pipeline (core/canvas-render.ts) server-side — extracts the
    // bound workflow's real step graph (or every registered workflow, for a
    // workspace overview) via @sapiom/agent-core's `check()` and lays it out
    // itself, typically well under a second, without touching the session's
    // pty at all. See "ai-visualize" below for the narrative/custom path.
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    requiresWorkflow: false,
    action: { kind: "render-canvas" },
  },
  {
    // The pre-deterministic-render behavior, kept as an explicit fallback for
    // custom/narrative views the structural extraction can't produce (e.g. a
    // description of *why* a step branches, not just that it does). Clones
    // the canvas kit template and asks the agent to hand-write the SVG using
    // its documented patterns — the same ~1-2 minute LLM round-trip
    // "visualize" used to always pay. That round-trip is exactly why it runs
    // as a background task (TaskManager) rather than injecting into the
    // user's own session: injecting a minutes-long prompt hijacks whatever
    // they were doing.
    id: "ai-visualize",
    label: "AI Visualize",
    icon: "Wand2",
    requiresWorkflow: false,
    execution: "background",
    action: {
      kind: "inject",
      submit: true,
      text: `Recreate .sapiom/canvas/index.html (that's {{canvas.path}}) from the canvas kit template. First read BOTH .sapiom/canvas/_template.html and the existing .sapiom/canvas/index.html — reading the current index.html before overwriting it is required, the Write tool refuses to overwrite a file it hasn't read. Then write index.html as a copy of the template, keeping the <style> block and every structural/pattern class untouched. Do not write new CSS. Then fill in the content: title, badges, subtitle, and stats values, and build the SVG graph using the template's node/edge markup patterns — see the <template id="canvas-patterns"> block in the cloned file for one example of each, and delete that block once you've copied what you need. Read .sapiom/harness-context.json first: if it has a boundWorkflow, draw that workflow's steps, control flow, and terminal outcomes; if boundWorkflow is null, draw one canvas-panel per workflow in its workflows list, plus an Interconnections panel showing how they hand off or signal to each other.`,
    },
  },
];
