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
      // Quoted path so workflow directories with spaces in the name (e.g.
      // "my workflow") don't split into separate shell words.
      text: 'cd "{{workflow.path}}" && sapiom agents run --target local',
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
      text: 'cd "{{workflow.path}}" && sapiom agents deploy',
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
      text: 'cd "{{workflow.path}}" && sapiom agents run --target prod',
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
