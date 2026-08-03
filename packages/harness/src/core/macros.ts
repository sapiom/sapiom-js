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
      // {{workflow.path}} is POSIX single-quoted at resolution time (macro-runner.ts
      // shellQuote), which stops spaces, dollar signs, backticks, and embedded
      // double-quotes from being interpreted by the shell.
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
      url: "https://app.sapiom.ai/agents/{{workflow.definitionId}}",
    },
  },
  {
    // One-click refresh of the bound workflow's canvas: drops the extraction
    // cache and re-runs the fully deterministic render (core/canvas-render.ts
    // — structure + derived annotations, no LLM, no user token), all
    // server-side without touching the session's pty. A cheap no-op when the
    // session is unbound.
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    requiresWorkflow: false,
    action: { kind: "render-canvas" },
  },
  {
    // "Describe with AI": runs the bound agent HEADLESS (claude -p, no pty, no
    // board takeover) to author the `description` fields in the workflow
    // source. execution:"background" routes it to the TaskManager instead of
    // the interactive terminal; the prompt is passed as {{subject}} (the SPA
    // builds it, web/src/lib/describe-prompt.ts). The source watcher re-renders
    // the canvas on save. Invoked programmatically (the canvas overview button),
    // never rendered in the action rail.
    id: "describe",
    label: "Describe with AI",
    icon: "Sparkles",
    requiresWorkflow: true,
    action: { kind: "inject", submit: true, text: "{{subject}}" },
    execution: "background",
  },
];
