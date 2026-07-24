/**
 * Fixture data for `VITE_MOCK=1` — lets the SPA render fully without a
 * running harness server (see MockApi in ./api).
 */
import type { HarnessEntry, HarnessSession, HarnessSettings, MacroDef, SessionSummary, WorkflowInfo } from "@shared/types";

const now = Date.now();
const minutesAgo = (n: number): string => new Date(now - n * 60_000).toISOString();
const daysAgo = (n: number): string => new Date(now - n * 24 * 60 * 60_000).toISOString();

/** The directory the harness itself was launched from (`npx @sapiom/harness [dir]`). */
/** Demo-only canvas overview content (the real renderer emits this inside
 * its own document; live mode therefore renders no app-side panel). */
export const MOCK_CANVAS_OVERVIEWS: Record<
  string,
  { description: string; stats: string; notes: string[] }
> = {
  "/Users/demo/acme-app/leasing": {
    description: "Handles lease applications end to end: screening, credit check, and approval routing.",
    // Counting rule shared with the Steps tab (canvas-graph's graphCounts):
    // pipeline steps exclude the two terminal exits, counted separately.
    stats: "4 steps · 2 exits · intake entry",
    notes: [
      "Applications default to manual review when the score field is missing.",
      "Only scores of 620 and above auto-draft a lease; everything else escalates.",
      "Both terminal steps are marked terminal-success in the graph.",
    ],
  },
};

export const MOCK_LAUNCH_DIR = "/Users/demo/acme-app";

/** The ONLY mock sessions with a real bundled canvas document under
 *  public/canvas/<id>/. The canvas pane must never mount an iframe for any
 *  other mock session — on the static Pages build that URL is GitHub's 404
 *  page, which would render inside the pane. Add a folder AND its id here
 *  together, never one without the other. */
export const MOCK_CANVAS_SESSIONS: readonly string[] = ["sess-boot"];

export function hasMockCanvasDoc(sessionId: string): boolean {
  return MOCK_CANVAS_SESSIONS.includes(sessionId);
}

/** Where MockApi.seedSampleProject pretends the example project landed —
 *  mirrors the real HARNESS_PATHS.sampleProject location. */
export const MOCK_SAMPLE_PROJECT_ROOT = "/Users/demo/.sapiom/harness/sample-project";

export const MOCK_SESSIONS: HarnessSession[] = [
  {
    id: "sess-boot",
    agentSessionId: null,
    // Bound by default so the "working on X" chip and the workspace tree's
    // highlight render immediately in mock mode, without requiring a click first.
    boundWorkflowPath: "/Users/demo/acme-app/leasing",
    harness: "claude-code",
    cwd: MOCK_LAUNCH_DIR,
    // The server auto-creates and starts one session in launchDir at boot, so
    // the app never opens to an empty terminal pane.
    title: "acme-app",
    status: "running",
    createdAt: minutesAgo(1),
    lastActiveAt: minutesAgo(1),
    ready: true,
  },
  {
    id: "sess-leasing",
    agentSessionId: "8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f",
    boundWorkflowPath: null,
    harness: "claude-code",
    cwd: "/Users/demo/acme-app",
    title: "Build the leasing pipeline",
    status: "exited",
    createdAt: minutesAgo(42),
    lastActiveAt: minutesAgo(20),
    exitCode: 0,
    ready: false,
  },
  {
    id: "sess-rfq",
    agentSessionId: "9c1a2b3d-4e5f-4061-8a7b-6c5d4e3f2a10",
    boundWorkflowPath: null,
    harness: "codex",
    cwd: "/Users/demo/rfq-workflows",
    title: "rfq-workflows",
    status: "exited",
    createdAt: daysAgo(2),
    lastActiveAt: daysAgo(1),
    exitCode: 0,
    ready: false,
  },
  {
    id: "sess-leasing-2",
    agentSessionId: "1a2b3c4d-5e6f-4a71-8b2c-3d4e5f6a7b8c",
    // A SECOND live session bound to leasing, so the focused agent's main-panel
    // tab strip is visibly multi-session on load: sess-boot is the active tab,
    // this one is the background tab. It is also MOCK_ACTIVITY_SESSION_ID, so
    // its tab carries the busy pulse shortly after load — the pulse only means
    // anything on a tab you are not already looking at.
    boundWorkflowPath: "/Users/demo/acme-app/leasing",
    harness: "claude-code",
    cwd: MOCK_LAUNCH_DIR,
    title: "acme-app",
    status: "running",
    // Later than sess-boot's createdAt (minutesAgo(1)) — tabs sort oldest-first,
    // so this keeps boot as tab 1 and this one as tab 2 (see smoke.spec.ts's
    // Cmd+1/Cmd+2 test).
    createdAt: minutesAgo(0),
    lastActiveAt: minutesAgo(0),
    ready: true,
  },
  {
    id: "sess-bg",
    agentSessionId: "2c3d4e5f-6a7b-4c81-9d2e-3f4a5b6c7d8e",
    boundWorkflowPath: null,
    harness: "claude-code",
    // A live session in a folder with NO agent (a bare scaffold session) — the
    // rail's one focusable folder row. cwd is deliberately "scratch" so it
    // keeps its own bare-folder group and never moves "onboarding-flow" out of
    // "No workspace" (see smoke.spec.ts's workspace-tree test).
    cwd: "/Users/demo/scratch",
    title: "scratch",
    status: "running",
    createdAt: minutesAgo(3),
    lastActiveAt: minutesAgo(3),
    ready: true,
  },
];

/** The mock session `subscribeEvents` fires one simulated `session.activity`
 *  ping for shortly after load — see ./events.ts. It is the FOCUSED agent's
 *  background tab (sess-leasing-2), so the tab strip's busy pulse shows on a
 *  tab you are not already looking at, without a real pty. */
export const MOCK_ACTIVITY_SESSION_ID = "sess-leasing-2";

/** Fake filesystem for the new-session directory picker (GET /api/fs/list). Keys are absolute paths. */
export const MOCK_FS_TREE: Record<string, string[]> = {
  "/": ["Users"],
  "/Users": ["demo"],
  "/Users/demo": ["acme-app", "rfq-workflows", "onboarding-flow", "scratch"],
  "/Users/demo/acme-app": ["leasing", "src", "docs"],
  "/Users/demo/acme-app/leasing": [],
  "/Users/demo/acme-app/src": [],
  "/Users/demo/acme-app/docs": [],
  "/Users/demo/rfq-workflows": ["src", "tests"],
  "/Users/demo/rfq-workflows/src": [],
  "/Users/demo/rfq-workflows/tests": [],
  "/Users/demo/onboarding-flow": [],
  "/Users/demo/scratch": [],
};

export const MOCK_HISTORY: Record<string, SessionSummary[]> = {
  "/Users/demo/acme-app": [
    {
      harnessSessionId: "sess-leasing",
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
      // Rich-meta fields: present on this entry (exercises the rich meta
      // line), absent on the others (exercises the graceful degradation).
      gitBranch: "feat/screening-webhook",
      messageCount: 12,
    },
  ],
  "/Users/demo/rfq-workflows": [
    {
      harnessSessionId: "sess-rfq",
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
  { name: "leasing", path: "/Users/demo/acme-app/leasing", definitionId: 4821, definitionSlug: "leasing", source: "scan" },
  { name: "rfq", path: "/Users/demo/rfq-workflows", definitionId: null, definitionSlug: null, source: "scan" },
  // Deployed like "leasing" but with a much longer name — exercises the
  // canvas header's deployed-dot staying pinned regardless of name length.
  { name: "onboarding-flow", path: "/Users/demo/onboarding-flow", definitionId: 9001, definitionSlug: "onboarding-flow", source: "connect" },
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
    // One-click force refresh: deterministic re-render + AI enrichment task
    // re-spawn, all server-side — no LLM in the render itself, no pty
    // involved. Matches the real DEFAULT_MACROS contract (src/core/macros.ts).
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    action: { kind: "render-canvas" },
    requiresWorkflow: false,
  },
];

/** Adapter registry fixture (GET /api/harnesses): mirrors the upstream
 *  HARNESS_ADAPTER_INFOS shape and order as of harness 0.1.4 — the two
 *  spawnable adapters installed (a healthy dev machine), the experimental
 *  and external ones present but not launchable, exactly as the server
 *  reports them. The installMcpPrompt strings are the per-agent copy-paste
 *  Sapiom MCP setup instructions the server ships for each adapter. */
export const MOCK_HARNESSES: HarnessEntry[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    mode: "embedded",
    experimental: false,
    installed: true,
    installMcpPrompt:
      "Add the Sapiom MCP server to this project: run `claude mcp add sapiom --transport http https://api.sapiom.ai/v1/mcp`, restart the session, then run /mcp to confirm the sapiom tools are listed.",
    // Mirrors the upstream adapter descriptors: claude-code and
    // codex read images from a file path, so the composer offers attach.
    imageInput: true,
  },
  {
    id: "codex",
    label: "Codex CLI",
    mode: "embedded",
    experimental: false,
    installed: true,
    installMcpPrompt:
      'Add the Sapiom MCP server to Codex: in ~/.codex/config.toml add an [mcp_servers.sapiom] entry with url = "https://api.sapiom.ai/v1/mcp", then restart Codex and confirm the sapiom tools are listed.',
    imageInput: true,
  },
  // The rest of the registry, honestly non-launchable: the pickers list them
  // disabled with the reason in a tooltip (no fabricated availability).
  {
    id: "pi",
    label: "pi",
    mode: "embedded",
    experimental: true,
    installed: false,
    installMcpPrompt: "",
    imageInput: false,
  },
  {
    id: "opencode",
    label: "opencode",
    mode: "embedded",
    experimental: true,
    installed: false,
    installMcpPrompt: "",
    imageInput: false,
  },
  {
    id: "conductor",
    label: "Conductor",
    mode: "external",
    experimental: false,
    installed: false,
    installMcpPrompt: "",
    imageInput: false,
  },
];

export const MOCK_SETTINGS: HarnessSettings = {
  telemetryOptIn: false,
  recentDirs: ["/Users/demo/acme-app", "/Users/demo/rfq-workflows", "/Users/demo/onboarding-flow"],
};


