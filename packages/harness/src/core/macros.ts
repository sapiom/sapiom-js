/**
 * Default action-rail macros. Pure data — no execution wiring. The server
 * resolves `{{...}}` placeholders (see MacroDef in shared/types.ts) and
 * either injects the text into the session pty or opens the URL.
 */
import type { MacroDef } from "../shared/types.js";

export const DEFAULT_MACROS: MacroDef[] = [
  {
    id: "run-local",
    label: "Run local",
    icon: "Play",
    requiresWorkflow: true,
    action: {
      kind: "inject",
      submit: true,
      text: "Run the agent at {{workflow.path}} locally against stub capabilities (the sapiom_dev_agents_run_local tool) and show me the per-step trace, including any unusedStubs or stubWarnings.",
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
      text: "Deploy the agent at {{workflow.path}} (link it if needed, then deploy) and report the build result.",
    },
  },
  {
    id: "prod-run",
    label: "Prod run",
    icon: "Zap",
    requiresWorkflow: true,
    action: {
      kind: "inject",
      submit: true,
      text: "Start a real cloud execution of the deployed agent at {{workflow.path}} and give me the executionId so I can track it.",
    },
  },
  {
    id: "open-prod",
    label: "Open prod",
    icon: "ExternalLink",
    action: {
      kind: "open-url",
      url: "https://app.sapiom.ai",
    },
  },
  {
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    action: {
      kind: "inject",
      submit: true,
      text: "Render {{subject}} as a self-contained static HTML page at {{canvas.path}} (inline any CSS/JS/data it needs) — I'll view it live in the canvas pane.",
    },
  },
];
