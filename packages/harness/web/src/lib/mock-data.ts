/**
 * Fixture data for `VITE_MOCK=1` — lets the SPA render fully without a
 * running harness server (see MockApi in ./api).
 */
import type {
  HarnessSession,
  HarnessSettings,
  MacroDef,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";
import type { SkillMeta } from "./api";

const now = Date.now();
const minutesAgo = (n: number): string =>
  new Date(now - n * 60_000).toISOString();
const daysAgo = (n: number): string =>
  new Date(now - n * 24 * 60 * 60_000).toISOString();

/** The directory the harness itself was launched from (`npx @sapiom/harness [dir]`). */
export const MOCK_LAUNCH_DIR = "/Users/demo/acme-app";

/** Where MockApi.seedSampleProject pretends the example project landed —
 *  mirrors the real HARNESS_PATHS.sampleProject location. */
export const MOCK_SAMPLE_PROJECT_ROOT =
  "/Users/demo/.sapiom/harness/sample-project";

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
    id: "sess-bg",
    agentSessionId: "1a2b3c4d-5e6f-4a71-8b2c-3d4e5f6a7b8c",
    boundWorkflowPath: null,
    harness: "claude-code",
    // A second running session, not the active tab on load — demonstrates the
    // tab strip (multiple live tabs) and the busy pulse (see
    // MOCK_ACTIVITY_SESSION_ID in ./events), which only means anything on a
    // tab you're not already looking at. cwd is deliberately "scratch" (no
    // workflow lives there) so it doesn't move "onboarding-flow" out of the
    // rail's "Other" group — see smoke.spec.ts's workspace-tree test.
    cwd: "/Users/demo/scratch",
    title: "scratch",
    status: "running",
    // Later than sess-boot's createdAt (minutesAgo(1)) — tabs sort
    // oldest-first, so this deliberately keeps boot as tab 1, scratch as
    // tab 2 (see smoke.spec.ts's Cmd+1/Cmd+2 test).
    createdAt: minutesAgo(0),
    lastActiveAt: minutesAgo(0),
    ready: true,
  },
];

/** The mock session `subscribeEvents` periodically fires simulated
 *  `session.activity` pings for — see ./events.ts. Exercises the tab strip's
 *  busy pulse on a background (non-active) tab without a real pty. */
export const MOCK_ACTIVITY_SESSION_ID = "sess-bg";

/** Fake filesystem for the new-session directory picker (GET /api/fs/list). Keys are absolute paths. */
export const MOCK_FS_TREE: Record<string, string[]> = {
  "/": ["Users"],
  "/Users": ["demo"],
  "/Users/demo": [
    "acme-app",
    "rfq-workflows",
    "onboarding-flow",
    "claims-triage",
    "scratch",
  ],
  "/Users/demo/acme-app": ["leasing", "src", "docs"],
  "/Users/demo/acme-app/leasing": [],
  "/Users/demo/acme-app/src": [],
  "/Users/demo/acme-app/docs": [],
  "/Users/demo/rfq-workflows": ["src", "tests"],
  "/Users/demo/rfq-workflows/src": [],
  "/Users/demo/rfq-workflows/tests": [],
  "/Users/demo/onboarding-flow": [],
  "/Users/demo/claims-triage": [],
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
  {
    name: "leasing",
    path: "/Users/demo/acme-app/leasing",
    definitionId: 4821,
    definitionSlug: "ic-diligence-orchestrator",
    source: "scan",
  },
  {
    name: "rfq",
    path: "/Users/demo/rfq-workflows",
    definitionId: null,
    definitionSlug: null,
    source: "scan",
  },
  // Deployed like "leasing" but with a much longer name — exercises the
  // canvas header's deployed-dot staying pinned regardless of name length.
  {
    name: "onboarding-flow",
    path: "/Users/demo/onboarding-flow",
    definitionId: 9001,
    definitionSlug: "onboarding-flow",
    source: "connect",
  },
  // Deployed (has a definitionId) but its slug hasn't resolved — e.g. the
  // harness isn't signed into the account that owns it. The snippet panel must
  // fall back to the project name (this `name`) and show the "inferred" note,
  // never a fill-in placeholder in the read-only slug field.
  {
    name: "claims-triage",
    path: "/Users/demo/claims-triage",
    definitionId: 7314,
    definitionSlug: null,
    source: "connect",
  },
];

export const MOCK_MACROS: MacroDef[] = [
  {
    id: "run_local",
    label: "Run local",
    icon: "Play",
    action: {
      kind: "inject",
      text: "cd {{workflow.path}} && sapiom agents run --target local",
      submit: true,
    },
    requiresWorkflow: true,
  },
  {
    id: "deploy",
    label: "Deploy",
    icon: "Cloud",
    action: {
      kind: "inject",
      text: "cd {{workflow.path}} && sapiom agents deploy",
      submit: true,
    },
    requiresWorkflow: true,
  },
  {
    id: "prod_run",
    label: "Prod run",
    icon: "Zap",
    action: {
      kind: "inject",
      text: "cd {{workflow.path}} && sapiom agents run --target prod",
      submit: true,
    },
    requiresWorkflow: true,
  },
  {
    id: "open_prod",
    label: "Open prod",
    icon: "ExternalLink",
    action: {
      kind: "open-url",
      url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}",
    },
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

export const MOCK_SETTINGS: HarnessSettings = {
  telemetryOptIn: false,
  recentDirs: [
    "/Users/demo/acme-app",
    "/Users/demo/rfq-workflows",
    "/Users/demo/onboarding-flow",
  ],
};

export const MOCK_SKILLS: SkillMeta[] = [
  {
    id: "sapiom-agent-authoring",
    name: "Agent Authoring",
    description:
      "Build, test, and deploy a Sapiom agent — a controlled, multi-step, deployable automation.",
    source: "package",
  },
  {
    id: "frontend-design",
    name: "Frontend Design",
    description:
      "Create distinctive, production-grade frontend interfaces with high design quality.",
    source: "user",
  },
  {
    id: "code-review",
    name: "Code Review",
    description:
      "Systematic review of code changes for correctness, style, and security.",
    source: "user",
  },
];

export const MOCK_SKILL_BODIES: Record<string, string> = {
  "sapiom-agent-authoring": `# Agent Authoring

A Sapiom **agent** is a small TypeScript project you author with your coding agent: a
\`defineAgent({ name, entry, steps })\` where each step's \`run(input, ctx)\` does work.

## Quick start

\`\`\`bash
sapiom agents init my-agent
cd my-agent
sapiom agents run --target local
\`\`\`

## Steps

Each step is a pure function that receives input and returns a directive:

- \`continue(output)\` — advance to the next step
- \`wait(signal)\` — pause until a signal arrives
- \`complete(result)\` — finish the agent run
`,
  "frontend-design": `# Frontend Design

Create distinctive, production-grade frontend interfaces with high design quality.

## Principles

- **Typography**: Choose fonts that are beautiful and unique
- **Color**: Commit to a cohesive aesthetic with CSS variables
- **Motion**: Use animations for micro-interactions
- **Composition**: Unexpected layouts, asymmetry, generous negative space

## Getting started

Tell the agent what you want to build — component, page, or application —
and describe the aesthetic direction (minimal, editorial, industrial, etc.).
`,
  "code-review": `# Code Review

Systematic review of code changes for correctness, style, and security.

## Checklist

- [ ] Logic is correct (no off-by-one, null dereference, race conditions)
- [ ] Error paths are handled
- [ ] Types are sound — no \`any\` without justification
- [ ] No debug artifacts (console.log, TODO, commented-out code)
- [ ] Tests cover the happy path and key error cases
`,
};
