/**
 * Default action-rail macros. Pure data — no execution wiring. The server
 * resolves `{{...}}` placeholders (see MacroDef in shared/types.ts) and
 * either injects the text into the session pty or opens the URL. Matches the
 * SPA's MOCK_MACROS fixture (web/src/lib/mock-data.ts) so mock and real mode
 * present the same action rail.
 *
 * NOTE: run_local, deploy, and prod_run are defined here as the identity for
 * the Studio's Local Run / Deploy / Prod Run buttons. The SPA routes their
 * onClick through the direct API (App.tsx handleRunMacroForWorkflow →
 * directActionKind), never through POST /api/macros/:id/run. The server route
 * rejects these three ids with a 4xx to close any PTY-inject bypass — but the
 * macros must exist in DEFAULT_MACROS so SessionStepsBar.tsx renders the
 * buttons (it filters on action.macro's presence).
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
      url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}",
    },
  },
  {
    // One-click force refresh of the bound workflow's canvas: re-runs the
    // deterministic, zero-LLM structure render (core/canvas-render.ts —
    // instant, cache-invalidated) AND re-spawns the bounded AI enrichment
    // task (core/canvas-enrich.ts, a headless background run that returns
    // validated JSON annotations, never HTML) — all server-side, without
    // touching the session's pty. A cheap no-op when the session is unbound.
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    requiresWorkflow: false,
    action: { kind: "render-canvas" },
  },
];
