/**
 * Fixture data for `VITE_MOCK=1` — lets the SPA render fully without a
 * running harness server (see MockApi in ./api).
 */
import type { HarnessSession, HarnessSettings, MacroDef, SessionSummary, WorkflowInfo } from "@shared/types";

const now = Date.now();
const minutesAgo = (n: number): string => new Date(now - n * 60_000).toISOString();
const daysAgo = (n: number): string => new Date(now - n * 24 * 60 * 60_000).toISOString();

export const MOCK_SESSIONS: HarnessSession[] = [
  {
    id: "sess-leasing",
    agentSessionId: "8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f",
    harness: "claude-code",
    cwd: "/Users/demo/acme-app",
    title: "Build the leasing pipeline",
    status: "running",
    createdAt: minutesAgo(42),
    lastActiveAt: minutesAgo(1),
  },
  {
    id: "sess-rfq",
    agentSessionId: null,
    harness: "codex",
    cwd: "/Users/demo/rfq-workflows",
    title: "rfq-workflows",
    status: "exited",
    createdAt: daysAgo(2),
    lastActiveAt: daysAgo(1),
    exitCode: 0,
  },
];

export const MOCK_HISTORY: Record<string, SessionSummary[]> = {
  "/Users/demo/acme-app": [
    {
      agentSessionId: "8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "Build the leasing pipeline",
      lastActiveAt: minutesAgo(1),
      source: "registry",
    },
    {
      agentSessionId: "2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "Wire the screening webhook",
      lastActiveAt: daysAgo(1),
      source: "transcript",
    },
  ],
  "/Users/demo/rfq-workflows": [
    {
      agentSessionId: "9c1a2b3d-4e5f-4061-8a7b-6c5d4e3f2a10",
      harness: "codex",
      cwd: "/Users/demo/rfq-workflows",
      title: "rfq-workflows",
      lastActiveAt: daysAgo(1),
      source: "registry",
    },
  ],
};

export const MOCK_WORKFLOWS: WorkflowInfo[] = [
  { name: "leasing", path: "/Users/demo/acme-app/leasing", definitionId: 4821, source: "scan" },
  { name: "rfq", path: "/Users/demo/rfq-workflows", definitionId: null, source: "scan" },
  { name: "onboarding-flow", path: "/Users/demo/onboarding-flow", definitionId: null, source: "connect" },
];

export const MOCK_MACROS: MacroDef[] = [
  {
    id: "run_local",
    label: "Run local",
    icon: "Play",
    action: { kind: "inject", text: "cd {{workflow.path}} && sapiom agents run --target local", submit: true },
    requiresWorkflow: true,
  },
  {
    id: "deploy",
    label: "Deploy",
    icon: "Cloud",
    action: { kind: "inject", text: "cd {{workflow.path}} && sapiom agents deploy", submit: true },
    requiresWorkflow: true,
  },
  {
    id: "prod_run",
    label: "Prod run",
    icon: "Zap",
    action: { kind: "inject", text: "cd {{workflow.path}} && sapiom agents run --target prod", submit: true },
    requiresWorkflow: true,
  },
  {
    id: "open_prod",
    label: "Open prod",
    icon: "ExternalLink",
    action: { kind: "open-url", url: "https://app.sapiom.ai/agents/{{workflow.definitionId}}" },
    requiresWorkflow: true,
  },
  {
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    action: {
      kind: "inject",
      text: "Write a live HTML visualization of {{subject}} to .sapiom/canvas/index.html and keep it updated as things change.",
      submit: true,
    },
    requiresWorkflow: false,
  },
];

export const MOCK_SETTINGS: HarnessSettings = {
  telemetryOptIn: false,
  recentDirs: ["/Users/demo/acme-app", "/Users/demo/rfq-workflows", "/Users/demo/onboarding-flow"],
};
