/**
 * Fixture data for `VITE_MOCK=1` — lets the SPA render fully without a
 * running harness server (see MockApi in ./api).
 */
import type {
  HarnessEntry,
  HarnessSession,
  HarnessSettings,
  MacroDef,
  SessionRecord,
  SessionSummary,
  TemplateDetailView,
  TemplateSummary,
  WorkflowInfo,
} from "@shared/types";

const now = Date.now();
const minutesAgo = (n: number): string =>
  new Date(now - n * 60_000).toISOString();
const daysAgo = (n: number): string =>
  new Date(now - n * 24 * 60 * 60_000).toISOString();

/** The directory the harness itself was launched from (`npx @sapiom/harness [dir]`). */
/** Demo-only canvas overview content (the real renderer emits this inside
 * its own document; live mode therefore renders no app-side panel). */
export const MOCK_CANVAS_OVERVIEWS: Record<
  string,
  { description: string; stats: string; notes: string[] }
> = {
  "/Users/demo/acme-app/leasing": {
    description:
      "Handles lease applications end to end: screening, credit check, and approval routing.",
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

/**
 * A slice of the real template catalog for mock mode. Spans several categories
 * on purpose — the dialog groups by category — and, since SAP-2088, one template
 * per complexity band.
 *
 * The set was previously picked for COST-state coverage (an estimate, a sub-cent
 * estimate, a null). Core no longer serves a cost, so the axis is the band:
 * Minimal through Advanced, plus `complexity: null` on `web-research-digest` to
 * exercise the absent-payload em dash. That null is not a claim about that
 * template — it genuinely scores Minimal, which `hello-agent` already covers, so
 * it is the one entry that can carry the "response predates the field" state
 * without costing band coverage.
 *
 * Every `complexity` here is what core's `scoreTemplateComplexity` actually
 * returns for the shape declared alongside it — the weights are `llmStep` 4,
 * `chainedLlmStep` 3, `mediaCapability` 3, `capability` 0.4, `step` 0.2,
 * `fanOut` 0.2 over `maxFanOut - 1`, banded at 1.5 / 4 / 7 / 11. Each `basis`
 * agrees with the `stepCount` and `capabilities` on the same object, so the
 * detail pane's explanation never contradicts the card above it. Change one and
 * you must re-derive the other.
 *
 * Each band also matches what `examples/registry.json` now AUTHORS for that
 * template (SAP-2086). Worth keeping true: once the backend prefers an authored
 * band over a derived one (SAP-2087), a fixture that only satisfied the scorer
 * would start disagreeing with the live catalog for the same id.
 *
 * Note `approval-chain`: 7 steps and a fan-out of 5, and still `Simple`. That
 * ordering is the scorer's whole point, not a mistake in this fixture — the band
 * tracks judgment and variance, not graph size, so a deterministic saga sits
 * below a two-model pipeline.
 */
export const MOCK_TEMPLATES: TemplateSummary[] = [
  {
    id: "hello-agent",
    name: "Hello Agent",
    description:
      "The minimal single-step agent: a smoke test for the build, deploy, run path.",
    tags: ["starter", "minimal"],
    category: "starter",
    cadence: "on-demand",
    stepCount: 1,
    capabilities: [],
    // raw 0.2 → Minimal.
    complexity: {
      score: 1,
      label: "Minimal",
      basis: {
        llmSteps: 0,
        chainedLlmSteps: 0,
        mediaCapabilities: 0,
        capabilityCount: 0,
        stepCount: 1,
        maxFanOut: 0,
      },
    },
  },
  {
    id: "web-research-digest",
    name: "Web Research Digest",
    description:
      "Search the web for a topic and return a concise, sourced digest.",
    tags: ["research", "search"],
    category: "data-knowledge",
    cadence: "on-demand",
    stepCount: 2,
    capabilities: ["web.search"],
    // The absent-payload case: a backend older than the complexity field. Renders
    // an em dash on the card and an honest "no band" line in the detail pane —
    // the guard that keeps an old Studio pointed at an old stack from throwing.
    complexity: null,
  },
  {
    id: "approval-chain",
    name: "Multi-Party Approval Chain (Saga)",
    description:
      "A durable sequential sign-off chain — pause-per-gate approvals with reminders, timeout escalation, and compensation on rejection.",
    tags: ["approval", "saga", "pause-resume", "durable"],
    category: "reliability-governance",
    cadence: "on-demand",
    stepCount: 7,
    capabilities: ["email.send", "database.create"],
    // raw 3.0 → Simple. Wholly deterministic despite being the largest graph here.
    complexity: {
      score: 2,
      label: "Simple",
      basis: {
        llmSteps: 0,
        chainedLlmSteps: 0,
        mediaCapabilities: 0,
        capabilityCount: 2,
        stepCount: 7,
        maxFanOut: 5,
      },
    },
  },
  {
    id: "scheduled-research-brief",
    name: "Scheduled Research Brief",
    description: "On a schedule, research a topic and deliver a written brief.",
    tags: ["research", "scheduled", "llm"],
    category: "data-knowledge",
    cadence: "scheduled",
    stepCount: 4,
    capabilities: ["web.search", "models.run"],
    // raw 5.6 → Moderate. One model step over a small graph: the mid-scale shape,
    // and the band a reader is most likely to meet.
    complexity: {
      score: 3,
      label: "Moderate",
      basis: {
        llmSteps: 1,
        chainedLlmSteps: 0,
        mediaCapabilities: 0,
        capabilityCount: 2,
        stepCount: 4,
        maxFanOut: 1,
      },
    },
  },
  {
    id: "cold-outreach-engine",
    name: "Cold Outreach Personalization Engine",
    description:
      "Enrich a lead list, write a personalized first line for each prospect, verify deliverability, then drip the sends.",
    tags: ["outreach", "email", "fan-out"],
    category: "revenue-marketing",
    cadence: "scheduled",
    stepCount: 6,
    capabilities: ["web.search", "email.send"],
    // raw 10.2 → Involved. Two model steps — enrichment and the per-prospect
    // rewrite — are what lift it well past the saga above.
    complexity: {
      score: 4,
      label: "Involved",
      basis: {
        llmSteps: 2,
        chainedLlmSteps: 0,
        mediaCapabilities: 0,
        capabilityCount: 2,
        stepCount: 6,
        maxFanOut: 2,
      },
    },
  },
  {
    id: "dependency-upgrade",
    name: "Dependency Upgrade",
    description:
      "On a schedule, a coding agent bumps a repo's dependencies in a sandbox, runs the tests, and opens a PR.",
    tags: ["coding-agent", "scheduled"],
    category: "product-engineering",
    cadence: "scheduled",
    stepCount: 5,
    capabilities: ["sandbox.run"],
    // raw 12.6 → Advanced. Two model steps, one feeding the other: chained
    // judgment is the heaviest signal in the scorer.
    complexity: {
      score: 5,
      label: "Advanced",
      basis: {
        llmSteps: 2,
        chainedLlmSteps: 1,
        mediaCapabilities: 0,
        capabilityCount: 1,
        stepCount: 5,
        maxFanOut: 2,
      },
    },
  },
];

/**
 * Real per-template graphs for mock mode, keyed by template id. Step NAMES are
 * the registry's actual ones (`search`/`summarize`, `greet`) because the e2e
 * suite addresses nodes by name — and because a synthesized `step-2` teaches a
 * reader nothing about what the preview looks like.
 *
 * `kind`/`sublabel` are what the server's `classifyStepKind` produces for each
 * shape, so mock mode renders the same branches live mode does. Note a
 * single-step template's one step is the ENTRY (entry outranks terminal in the
 * precedence), which is why `greet` is not an exit node.
 */
export const MOCK_TEMPLATE_GRAPHS: Record<
  string,
  Pick<TemplateDetailView, "steps" | "transitions">
> = {
  "hello-agent": {
    steps: [
      {
        name: "greet",
        description: "Validate the input and return a greeting.",
        capabilities: [],
        kind: "entry",
        sublabel: "entry",
      },
    ],
    transitions: [],
  },
  "web-research-digest": {
    steps: [
      {
        name: "search",
        description: "Query the web for the topic.",
        capabilities: ["web.search"],
        kind: "entry",
        sublabel: "entry",
      },
      {
        name: "summarize",
        description: "Condense the results into a sourced digest.",
        capabilities: [],
        kind: "terminal-success",
        sublabel: "terminal · success",
      },
    ],
    transitions: [
      { from: "search", to: "summarize", label: null, kind: "continue" },
    ],
  },
  "dependency-upgrade": {
    steps: [
      {
        name: "scan",
        description: "List outdated dependencies.",
        capabilities: ["sandbox.run"],
        kind: "entry",
        sublabel: "entry",
      },
      {
        name: "bump",
        description: "Apply the upgrades in a sandbox.",
        capabilities: [],
        kind: "step",
        sublabel: "step",
      },
      {
        name: "test",
        description: "Run the suite against the bumped tree.",
        capabilities: [],
        kind: "step",
        sublabel: "step · can also terminate",
      },
      {
        name: "open_pr",
        description: "Open a PR with the passing upgrade.",
        capabilities: [],
        kind: "terminal-success",
        sublabel: "terminal · success",
      },
      // A fail-only sink: amber "needs attention", NOT a green success exit.
      {
        name: "give_up",
        description: "Tests still failing after retries.",
        capabilities: [],
        kind: "terminal-warn",
        sublabel: "terminal · needs attention",
      },
    ],
    transitions: [
      { from: "scan", to: "bump", label: null, kind: "continue" },
      { from: "bump", to: "test", label: null, kind: "continue" },
      { from: "test", to: "open_pr", label: null, kind: "continue" },
      { from: "test", to: "give_up", label: null, kind: "continue" },
    ],
  },
  "approval-chain": {
    steps: [
      {
        name: "start",
        description: "Record the request.",
        capabilities: ["database.create"],
        kind: "entry",
        sublabel: "entry",
      },
      {
        name: "present",
        description: "Email the current gate's approver.",
        capabilities: ["email.send"],
        kind: "step",
        sublabel: "step",
      },
      // A pause step shows the signal it waits for.
      {
        name: "decide",
        description: "Wait for the approver's answer.",
        capabilities: [],
        kind: "pause",
        sublabel: "pause · approval.decided",
      },
      {
        name: "finalize",
        description: "All gates passed.",
        capabilities: ["email.send"],
        kind: "terminal-success",
        sublabel: "terminal · success",
      },
      {
        name: "compensate",
        description: "Roll back on rejection.",
        capabilities: ["email.send"],
        kind: "terminal-warn",
        sublabel: "terminal · needs attention",
      },
    ],
    transitions: [
      { from: "start", to: "present", label: null, kind: "continue" },
      { from: "present", to: "decide", label: null, kind: "continue" },
      {
        from: "decide",
        to: "finalize",
        label: "approval.decided",
        kind: "pause",
      },
      { from: "decide", to: "compensate", label: null, kind: "continue" },
    ],
  },
  "cold-outreach-engine": {
    steps: [
      {
        name: "enrich",
        description: "Enrich the lead list.",
        capabilities: ["web.search"],
        kind: "entry",
        sublabel: "entry",
      },
      {
        name: "personalize",
        description: "Write a first line per prospect.",
        capabilities: [],
        kind: "step",
        sublabel: "step",
      },
      {
        name: "send",
        description: "Drip the sends.",
        capabilities: ["email.send"],
        kind: "terminal-success",
        sublabel: "terminal · success",
      },
    ],
    transitions: [
      { from: "enrich", to: "personalize", label: null, kind: "continue" },
      { from: "personalize", to: "send", label: null, kind: "continue" },
    ],
  },
  // Four steps, matching this template's `stepCount` and the `basis.stepCount`
  // its band was derived from — the linear search → summarize → deliver shape the
  // registry declares, with the one model step the Moderate band turns on.
  "scheduled-research-brief": {
    steps: [
      {
        name: "search",
        description: "Gather sources on the topic.",
        capabilities: ["web.search"],
        kind: "entry",
        sublabel: "entry",
      },
      {
        name: "summarize",
        description: "Draft the brief from the sources.",
        capabilities: ["models.run"],
        kind: "step",
        sublabel: "step",
      },
      {
        name: "review",
        description: "Check the brief covers the ask.",
        capabilities: [],
        kind: "step",
        sublabel: "step",
      },
      {
        name: "deliver",
        description: "Send the finished brief.",
        capabilities: [],
        kind: "terminal-success",
        sublabel: "terminal · success",
      },
    ],
    transitions: [
      { from: "search", to: "summarize", label: null, kind: "continue" },
      { from: "summarize", to: "review", label: null, kind: "continue" },
      { from: "review", to: "deliver", label: null, kind: "continue" },
    ],
  },
};

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
    cwd: "/Users/demo/rfq-agent",
    title: "rfq-agent",
    status: "exited",
    createdAt: daysAgo(2),
    lastActiveAt: daysAgo(1),
    exitCode: 0,
    ready: false,
  },
  {
    // A PHANTOM: the SessionStart hook gave us an agentSessionId, but the user
    // never submitted a prompt, so Claude Code wrote no transcript and
    // `--resume` would exit 1. The registry can't tell this apart from a real
    // session on its own — only the server's canResume probe can, which is why
    // MOCK_HISTORY reports this row as `rehydrate`.
    id: "sess-phantom",
    agentSessionId: "7e5f4d3c-2b1a-4098-8765-4321fedcba98",
    boundWorkflowPath: null,
    harness: "claude-code",
    cwd: "/Users/demo/acme-app",
    title: "acme-app",
    status: "exited",
    createdAt: daysAgo(1),
    lastActiveAt: daysAgo(1),
    exitCode: 1,
    ready: false,
  },
  {
    // Exited, and the agent's transcript for it is gone — so its history row
    // is `rehydrate` even though we recorded the whole conversation (see
    // MOCK_SESSION_RECORDS["sess-pricing"]). Continuing it starts a fresh
    // session seeded from that record rather than resuming anything.
    id: "sess-pricing",
    agentSessionId: "4d8c1e77-9a03-4b52-8e61-0c2d5f7a1b93",
    boundWorkflowPath: null,
    harness: "claude-code",
    cwd: "/Users/demo/acme-app",
    title: "Rework the pricing tiers",
    status: "exited",
    createdAt: daysAgo(3),
    lastActiveAt: daysAgo(3),
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
  "/Users/demo": ["acme-app", "rfq-agent", "onboarding-flow", "scratch"],
  "/Users/demo/acme-app": ["leasing", "src", "docs"],
  "/Users/demo/acme-app/leasing": [],
  "/Users/demo/acme-app/src": [],
  "/Users/demo/acme-app/docs": [],
  "/Users/demo/rfq-agent": ["src", "tests"],
  "/Users/demo/rfq-agent/src": [],
  "/Users/demo/rfq-agent/tests": [],
  "/Users/demo/onboarding-flow": [],
  "/Users/demo/scratch": [],
};

/**
 * `resumeMode` on every row is what the real server resolves by probing the
 * agent's own store (`HarnessAdapter.canResume`), never something the client
 * derives — so the fixtures carry all three interesting shapes: a registry row
 * the agent still holds, a registry row it doesn't (the phantom), and a
 * transcript-only row that is genuinely resumable via adopt.
 */
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
      resumeMode: "agent-resume",
    },
    {
      // The phantom's history row: we hold its agentSessionId, the agent holds
      // no conversation for it. This is the row that used to render
      // "resumable" and hand the user a guaranteed exit-1.
      harnessSessionId: "sess-phantom",
      agentSessionId: "7e5f4d3c-2b1a-4098-8765-4321fedcba98",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "acme-app",
      lastActiveAt: daysAgo(1),
      source: "registry",
      resumeMode: "rehydrate",
    },
    {
      agentSessionId: "2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "Wire the screening webhook",
      lastActiveAt: daysAgo(1),
      source: "transcript",
      // Transcript-only, but the transcript really is there — so it adopts
      // into the registry and resumes for real rather than opening a fresh
      // session, which is what the hardcoded `resumable={false}` forced.
      resumeMode: "agent-resume",
      // Rich-meta fields: present on this entry (exercises the rich meta
      // line), absent on the others (exercises the graceful degradation).
      gitBranch: "feat/screening-webhook",
      messageCount: 12,
      // turnCount comes from OUR event index and wins over messageCount when
      // both are present — the two disagreeing here is deliberate.
      turnCount: 3,
    },
    {
      // The row portable continue exists for: the agent's transcript is gone
      // (rotated, or the machine changed), so nothing can reattach — but WE
      // recorded the conversation, so continuing it means a fresh session
      // seeded from our own record. Contrast the phantom above, which is
      // `rehydrate` with nothing recorded either side.
      harnessSessionId: "sess-pricing",
      agentSessionId: "4d8c1e77-9a03-4b52-8e61-0c2d5f7a1b93",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "Rework the pricing tiers",
      lastActiveAt: daysAgo(3),
      source: "registry",
      resumeMode: "rehydrate",
      gitBranch: "feat/pricing-tiers",
      turnCount: 2,
    },
    {
      // A session the Studio never ran: the agent's own transcript knows it,
      // our event log doesn't. No turnCount, and no record — the review pane's
      // honest "nothing recorded" state (see MOCK_SESSION_RECORDS).
      //
      // `agent-resume` alongside no record is the combination worth having a
      // fixture for: the agent can continue this conversation, and we still
      // can't show it, because resumability and readability come from two
      // different stores.
      agentSessionId: "5e7a0c94-3f22-4d18-b6e1-77c0a9b12d40",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "Poke at the credit model",
      lastActiveAt: daysAgo(6),
      source: "transcript",
      resumeMode: "agent-resume",
    },
    {
      // Old enough that its events are long gone from events.ndjson (50 MB /
      // 30 days) — it renders from its archived record instead, and says so.
      // Its `turnCount` is the conversation's, not the archive's: the archive
      // only had room for the last two turns.
      harnessSessionId: "sess-migration",
      agentSessionId: "4a1c8e22-9b70-4f35-a1d2-3e4f5a6b7c8d",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "Migrate the applicant schema",
      lastActiveAt: daysAgo(45),
      source: "registry",
      resumeMode: "rehydrate",
      turnCount: 9,
    },
  ],
  "/Users/demo/rfq-agent": [
    {
      harnessSessionId: "sess-rfq",
      agentSessionId: "9c1a2b3d-4e5f-4061-8a7b-6c5d4e3f2a10",
      harness: "codex",
      cwd: "/Users/demo/rfq-agent",
      title: "rfq-agent",
      lastActiveAt: daysAgo(1),
      source: "registry",
      resumeMode: "agent-resume",
      turnCount: 1,
    },
  ],
};

/**
 * Reconstructed transcripts for the past-session review pane, keyed by the id
 * the pane asks with (harnessSessionId when the registry tracked the session,
 * else the agent's own session id).
 *
 * Deliberately covers the honest-gap cases the real fold produces, so the mock
 * UI shows what a user will actually see: a truncated tool result, a turn with
 * tool calls plus only a final assistant message, a Codex session with no
 * assistant text at all, and a trailing turn that never completed.
 */
export const MOCK_SESSION_RECORDS: Record<string, SessionRecord> = {
  "sess-leasing": {
    harnessSessionId: "sess-leasing",
    mergedSessionIds: ["sess-leasing"],
    agentSessionId: "8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f",
    harness: "claude-code",
    cwd: "/Users/demo/acme-app",
    startedAt: minutesAgo(48),
    endedAt: minutesAgo(1),
    turnCount: 2,
    eventCount: 9,
    reconstructed: true,
    // Folded live from events.ndjson — nothing archived about it yet.
    archivedAt: null,
    limitations: [
      "truncated-tool-output",
      "assistant-narration-gap",
      "incomplete-final-turn",
    ],
    turns: [
      {
        index: 1,
        prompt:
          "Add the screening step to the leasing agent and wire it to the credit check.",
        promptAt: minutesAgo(48),
        toolCalls: [
          {
            name: "Read",
            input: '{"file_path":"/Users/demo/acme-app/leasing/index.ts"}',
            responseSummary: "export const leasing = defineAgent({ … })",
            responseTruncated: false,
            at: minutesAgo(47),
          },
          {
            name: "Edit",
            input:
              '{"file_path":"/Users/demo/acme-app/leasing/index.ts","old_string":"steps: [apply]","new_string":"steps: [apply, screening]"}',
            responseSummary:
              "Applied 1 edit to /Users/demo/acme-app/leasing/index.ts\n…[truncated 2048 chars]",
            responseTruncated: true,
            at: minutesAgo(46),
          },
        ],
        assistantText:
          "Added a `screening` step between `apply` and `creditCheck`, and wired its output into the credit check's input. Run it locally to confirm the new edge.",
        model: "claude-opus-4-6",
        usage: { inputTokens: 18420, outputTokens: 612 },
        completedAt: minutesAgo(45),
        incomplete: false,
      },
      {
        index: 2,
        prompt: "Now deploy it.",
        promptAt: minutesAgo(3),
        toolCalls: [
          {
            name: "Bash",
            input: '{"command":"sapiom agents deploy"}',
            responseSummary: "building…",
            responseTruncated: false,
            at: minutesAgo(2),
          },
        ],
        assistantText: null,
        model: null,
        usage: null,
        completedAt: null,
        incomplete: true,
      },
    ],
  },
  "2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33": {
    harnessSessionId: "sess-webhook",
    mergedSessionIds: ["sess-webhook"],
    agentSessionId: "2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33",
    harness: "claude-code",
    cwd: "/Users/demo/acme-app",
    startedAt: daysAgo(1),
    endedAt: daysAgo(1),
    turnCount: 3,
    eventCount: 11,
    reconstructed: true,
    archivedAt: null,
    limitations: ["assistant-narration-gap"],
    turns: [
      {
        index: 1,
        prompt: "Wire the screening webhook to the applicant queue.",
        promptAt: daysAgo(1),
        toolCalls: [
          {
            name: "Grep",
            input: '{"pattern":"applicantQueue"}',
            responseSummary: "leasing/queue.ts:12\nleasing/screening.ts:44",
            responseTruncated: false,
            at: daysAgo(1),
          },
        ],
        assistantText:
          "Wired it through `applicantQueue.publish()` and added the retry policy.",
        model: "claude-opus-4-6",
        usage: { inputTokens: 9120, outputTokens: 340 },
        completedAt: daysAgo(1),
        incomplete: false,
      },
      {
        index: 2,
        prompt: "Add a test for the retry path.",
        promptAt: daysAgo(1),
        toolCalls: [],
        assistantText:
          "Added `screening.retry.test.ts` covering the 5xx-then-success path.",
        model: "claude-opus-4-6",
        usage: { inputTokens: 10240, outputTokens: 210 },
        completedAt: daysAgo(1),
        incomplete: false,
      },
      {
        index: 3,
        prompt: "Ship it.",
        promptAt: daysAgo(1),
        toolCalls: [],
        assistantText: "Pushed to `feat/screening-webhook`.",
        model: "claude-opus-4-6",
        usage: { inputTokens: 11010, outputTokens: 96 },
        completedAt: daysAgo(1),
        incomplete: false,
      },
    ],
  },
  // The rehydration fixture: a record whose agent no longer holds the
  // conversation, so "Continue" seeds a fresh session from this instead of
  // resuming. See its MOCK_HISTORY row.
  "sess-pricing": {
    harnessSessionId: "sess-pricing",
    mergedSessionIds: ["sess-pricing"],
    agentSessionId: "4d8c1e77-9a03-4b52-8e61-0c2d5f7a1b93",
    harness: "claude-code",
    cwd: "/Users/demo/acme-app",
    startedAt: daysAgo(3),
    endedAt: daysAgo(3),
    turnCount: 2,
    eventCount: 8,
    reconstructed: true,
    archivedAt: null,
    limitations: ["assistant-narration-gap"],
    turns: [
      {
        index: 1,
        prompt: "Rework the pricing tiers so the mid tier is usage-metered.",
        promptAt: daysAgo(3),
        toolCalls: [
          {
            name: "Edit",
            input: '{"file_path":"/Users/demo/acme-app/src/pricing/tiers.ts"}',
            responseSummary: "updated 1 hunk",
            responseTruncated: false,
            at: daysAgo(3),
          },
        ],
        assistantText:
          "Mid tier is metered now; the annual discount still needs deciding.",
        model: "claude-opus-4-6",
        usage: { inputTokens: 8210, outputTokens: 280 },
        completedAt: daysAgo(3),
        incomplete: false,
      },
      {
        index: 2,
        prompt: "Leave the discount for now — add the migration.",
        promptAt: daysAgo(3),
        toolCalls: [
          {
            name: "Write",
            input:
              '{"file_path":"/Users/demo/acme-app/migrations/0042-pricing.sql"}',
            responseSummary: "wrote 34 lines",
            responseTruncated: false,
            at: daysAgo(3),
          },
        ],
        assistantText: "Migration 0042 added. Not run anywhere yet.",
        model: "claude-opus-4-6",
        usage: { inputTokens: 8940, outputTokens: 160 },
        completedAt: daysAgo(3),
        incomplete: false,
      },
    ],
  },
  "sess-rfq": {
    harnessSessionId: "sess-rfq",
    mergedSessionIds: ["sess-rfq"],
    agentSessionId: "9c1a2b3d-4e5f-4061-8a7b-6c5d4e3f2a10",
    harness: "codex",
    cwd: "/Users/demo/rfq-agent",
    startedAt: daysAgo(1),
    endedAt: null,
    turnCount: 1,
    eventCount: 4,
    reconstructed: true,
    archivedAt: null,
    // Codex's rollout carries no equivalent of the Stop hook's final assistant
    // message, so a Codex record has the chronology but none of the prose.
    limitations: ["missing-assistant-text"],
    turns: [
      {
        index: 1,
        prompt: "Summarize what the rfq agent does.",
        promptAt: daysAgo(1),
        toolCalls: [
          {
            name: "shell",
            input: '{"command":["cat","README.md"]}',
            responseSummary:
              "# rfq-agent\nRequest-for-quote intake and routing.",
            responseTruncated: false,
            at: daysAgo(1),
          },
        ],
        assistantText: null,
        model: null,
        usage: null,
        completedAt: daysAgo(1),
        incomplete: false,
      },
    ],
  },
  /**
   * An ARCHIVED record: this session's events aged out of events.ndjson weeks
   * ago, and what's left is the compacted copy under
   * `~/.sapiom/harness/records/` (see core/record-archive.ts). Shaped exactly
   * like the real thing — `archivedAt` set, tool payloads clipped with the
   * collector's own marker, `turnCount` still 9 while `turns` holds the last
   * two, and both losses named in `limitations`.
   */
  "sess-migration": {
    harnessSessionId: "sess-migration",
    mergedSessionIds: ["sess-migration"],
    agentSessionId: "4a1c8e22-9b70-4f35-a1d2-3e4f5a6b7c8d",
    harness: "claude-code",
    cwd: "/Users/demo/acme-app",
    startedAt: daysAgo(45),
    endedAt: daysAgo(45),
    turnCount: 9,
    eventCount: 61,
    reconstructed: true,
    archivedAt: daysAgo(45),
    limitations: [
      "truncated-tool-output",
      "compacted-archive",
      "dropped-early-turns",
    ],
    turns: [
      {
        index: 8,
        prompt: "Backfill the applicant rows that predate the schema change.",
        promptAt: daysAgo(45),
        toolCalls: [
          {
            name: "Bash",
            input: '{"command":"pnpm migrate:applicants --backfill"}',
            responseSummary: "migrating 41,203 rows…[truncated 3184 chars]",
            responseTruncated: true,
            at: daysAgo(45),
          },
        ],
        assistantText:
          "Backfilled 41,203 applicant rows; 12 failed validation and are listed in `backfill-errors.json`.",
        model: "claude-opus-4-6",
        usage: { inputTokens: 21400, outputTokens: 480 },
        completedAt: daysAgo(45),
        incomplete: false,
      },
      {
        index: 9,
        prompt: "Ship the migration and note the 12 failures in the changelog.",
        promptAt: daysAgo(45),
        toolCalls: [],
        assistantText:
          "Shipped, with the 12 unmigrated applicants called out under Known issues.",
        model: "claude-opus-4-6",
        usage: { inputTokens: 22100, outputTokens: 130 },
        completedAt: daysAgo(45),
        incomplete: false,
      },
    ],
  },
};

export const MOCK_WORKFLOWS: WorkflowInfo[] = [
  {
    name: "leasing",
    path: "/Users/demo/acme-app/leasing",
    definitionId: 4821,
    definitionSlug: "leasing",
    activeBuildRunId: "build-leasing-ready",
    activeBuildRunStatus: "ready",
    source: "scan",
  },
  {
    name: "rfq",
    path: "/Users/demo/rfq-agent",
    definitionId: null,
    definitionSlug: null,
    activeBuildRunId: null,
    activeBuildRunStatus: null,
    source: "scan",
  },
  // Deployed like "leasing" but with a much longer name — exercises the
  // canvas header's deployed-dot staying pinned regardless of name length.
  {
    name: "onboarding-flow",
    path: "/Users/demo/onboarding-flow",
    definitionId: 9001,
    definitionSlug: "onboarding-flow",
    activeBuildRunId: "build-onboarding-ready",
    activeBuildRunStatus: "ready",
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
    // One-click force refresh: deterministic extraction + derived annotations,
    // all server-side — no LLM and no pty involved. Matches the real
    // DEFAULT_MACROS contract (src/core/macros.ts).
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    action: { kind: "render-canvas" },
    requiresWorkflow: false,
  },
  {
    // "Describe with AI" — headless background authoring pass. Mirrors the real
    // DEFAULT_MACROS contract (src/core/macros.ts). Invoked programmatically by
    // the canvas overview button, never rendered in the action rail.
    id: "describe",
    label: "Describe with AI",
    icon: "Sparkles",
    action: { kind: "inject", text: "{{subject}}", submit: true },
    requiresWorkflow: true,
    execution: "background",
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
      "Add Sapiom Project MCP to this project: run `claude mcp add sapiom-project -- npx -y @sapiom/mcp`, restart the session, then run /mcp to confirm the Sapiom project tools are listed.",
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
      "Add Sapiom Project MCP to Codex: run `codex mcp add sapiom-project -- npx -y @sapiom/mcp`, then restart Codex and confirm the Sapiom project tools are listed.",
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
  recentDirs: [
    "/Users/demo/acme-app",
    "/Users/demo/rfq-agent",
    "/Users/demo/onboarding-flow",
  ],
  // Matches the real default: opt-in, because it spends tokens on a background
  // LLM call the user never asked for.
  rollingSummary: false,
};
