/**
 * Sapiom Harness — shared interface contract.
 *
 * Every workstream (terminal core, SPA, analytics, CLI, canvas) builds against
 * the types in this file. Change them only by agreement — this file is the
 * integration boundary.
 */

// ---------------------------------------------------------------------------
// Constants & well-known paths
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 4100;

/** All harness-owned state lives under this directory. Uninstall = delete it. */
export const HARNESS_HOME = "~/.sapiom/harness";

export const HARNESS_PATHS = {
  /** Stable anonymous install id (uuid, created on first run). */
  machineId: `${HARNESS_HOME}/machine-id`,
  /** Session registry — HarnessSession[] as JSON. */
  sessions: `${HARNESS_HOME}/sessions.json`,
  /** Workflow registry — WorkflowInfo[] as JSON. */
  workflows: `${HARNESS_HOME}/workflows.json`,
  /** Local analytics sink (one AnalyticsEvent per line). Always written. */
  events: `${HARNESS_HOME}/events.ndjson`,
  /** User settings (opt-in state, macros overrides). */
  settings: `${HARNESS_HOME}/settings.json`,
  /** Generated per-session agent config (claude settings/mcp-config files). */
  generated: `${HARNESS_HOME}/generated`,
  /** The bundled example project, seeded lazily by POST /api/sample-project
   *  (the welcome panel's "Run the sample project") — stable so re-running
   *  the sample reuses the same copy instead of scattering fresh ones. */
  sampleProject: `${HARNESS_HOME}/sample-project`,
} as const;

/**
 * Canvas convention: agents write static HTML here, relative to the session
 * cwd. The server watches this directory and serves it at
 * `/canvas/<harnessSessionId>/`.
 */
export const CANVAS_DIR = ".sapiom/canvas";
export const CANVAS_INDEX = `${CANVAS_DIR}/index.html`;

/**
 * Deterministic per-workflow renders live here (one `<slug>.html` per
 * workflow, slugged by `slugForWorkflowPath` in core/canvas-render.ts),
 * relative to the session cwd. `GET /canvas/:sessionId/` serves the bound
 * workflow's render from this directory; `index.html` above stays the
 * agent-authored/custom canvas and is never rewritten by the deterministic
 * pipeline.
 */
export const CANVAS_RENDERS_DIR = `${CANVAS_DIR}/renders`;

/**
 * Per-workflow enrichment cache lives here (one `<slug>.json` per workflow,
 * same slug scheme as CANVAS_RENDERS_DIR), relative to the session cwd:
 * `{ graph, enrichment, sourceFingerprint, enrichedAt }`. A stale
 * sourceFingerprint keeps the enrichment displayed (with a "stale" chip)
 * until a re-run replaces it — see core/canvas-enrich.ts.
 */
export const CANVAS_CACHE_DIR = `${CANVAS_DIR}/cache`;

/**
 * Workspace-state convention: the harness mirrors this session's binding,
 * the full workflow registry, and its own identity here, relative to the
 * session cwd, so the agent has an always-current, agent-legible answer to
 * "what am I working on" and "what workflows exist" without asking. Written
 * on session create, on every `PATCH /api/sessions/:id/workflow`, and
 * whenever the workflow registry changes (scan/connect) — see
 * HarnessWorkspaceContext. Kept present (never deleted) even on unbind.
 */
export const HARNESS_CONTEXT_FILE = ".sapiom/harness-context.json";

/**
 * Environment variables passed to hook scripts / child processes.
 * INGEST_TOKEN is a per-boot secret; /ingest rejects requests without it.
 */
export const ENV = {
  ingestUrl: "SAPIOM_HARNESS_INGEST_URL",
  ingestToken: "SAPIOM_HARNESS_INGEST_TOKEN",
  sessionId: "SAPIOM_HARNESS_SESSION_ID",
  collectorUrl: "SAPIOM_COLLECTOR_URL",
} as const;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Every harness kind that can be spawned as a session — i.e. has a full
 * runtime adapter (launch/resume/doctor/listPastSessions) and a real e2e
 * suite. Both `HarnessKind` and the zod enum in server/rest.ts are derived
 * from this tuple so they can never drift from each other.
 *
 * External-mode adapters (conductor) and scaffold adapters that haven't
 * earned an e2e suite yet (pi, opencode) are deliberately absent: the
 * picker and POST /sessions reject them at the validation layer.
 */
export const SPAWNABLE_HARNESS_KINDS = ["claude-code", "codex"] as const;

export type HarnessKind = (typeof SPAWNABLE_HARNESS_KINDS)[number];

export type SessionStatus = "starting" | "running" | "exited";

/** A harness session = one pty running one agent process in one directory. */
export interface HarnessSession {
  /** Our id (uuid). */
  id: string;
  /** The agent's own session id (Claude session uuid / Codex rollout id), once known. */
  agentSessionId: string | null;
  harness: HarnessKind;
  /** Absolute path of the project directory the agent runs in. */
  cwd: string;
  /** Display title (first prompt, or directory basename until known). */
  title: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  /** Exit code when status === "exited". */
  exitCode?: number | null;
  /** The workflow (by path) this session is currently bound to, if any. Set
   *  via `PATCH /api/sessions/:id/workflow`; mirrored into
   *  HARNESS_CONTEXT_FILE in the session's cwd so the agent can read it. */
  boundWorkflowPath: string | null;
  /**
   * `status === "running"` only means the pty is alive — the agent's TUI
   * can still be sitting on a blocking prompt (most commonly: "trust this
   * directory?") that isn't accepting real input yet. `ready` is the
   * stronger signal: this pty is actually interactive. Reset to `false` on
   * every fresh spawn (including resume) and only ever set by
   * `SessionManager.setReady()` — see there for what flips it. Injecting
   * input (macros, `/sessions/:id/input`) against a not-ready session
   * queues briefly then fails loudly (`SessionNotReadyError`) rather than
   * silently writing into a TUI that isn't listening; raw terminal
   * keystrokes (`write()`) are deliberately never gated on this, since a
   * human must always be able to answer the blocking prompt themselves.
   */
  ready: boolean;
}

/** A resumable past session discovered from agent transcripts or our registry. */
export interface SessionSummary {
  /** Back-reference to our session when the registry tracked it (source "registry"). */
  harnessSessionId?: string;
  agentSessionId: string;
  harness: HarnessKind;
  cwd: string;
  title: string;
  lastActiveAt: string;
  source: "registry" | "transcript";
}

// ---------------------------------------------------------------------------
// Harness adapters (the interface contract with each coding agent)
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Merged over process.env. Use `null` to unset a variable. */
  env: Record<string, string | null>;
  cwd: string;
}

export interface LaunchOpts {
  harnessSessionId: string;
  cwd: string;
  /** Absolute path to the generated system-prompt file (profile). */
  systemPromptFile?: string;
  /** Absolute path to the generated MCP config file. */
  mcpConfigFile?: string;
  /** Absolute path to the generated settings file (hooks). Claude only. */
  settingsFile?: string;
  /**
   * Absolute path to a generated --plugin-dir directory. Currently used to
   * inject Sapiom's bundled skills as session-scoped slash commands via
   * claude-code's `--plugin-dir` flag. Adapters that don't support
   * --plugin-dir (e.g. codex) silently ignore this field.
   */
  pluginDir?: string;
  /** Only consulted by `launchTask` — the one-shot prompt a headless
   *  background task runs, then exits. Unused by `launch`/`resume`. */
  prompt?: string;
  /** Only consulted by `launchTask` — model override (`--model`), e.g.
   *  "sonnet". Interactive sessions keep the user's own default. */
  model?: string;
  /** Only consulted by `launchTask` — hard cap on agent turns
   *  (`--max-turns`), so a bounded task can't run away. */
  maxTurns?: number;
}

/**
 * One implementation per supported coding agent. Implementations must be
 * side-effect free until `launch`/`resume` specs are actually spawned.
 */
export interface HarnessAdapter {
  id: HarnessKind;
  /** Binary present, version acceptable. */
  doctor(): Promise<DoctorCheck[]>;
  launch(opts: LaunchOpts): SpawnSpec;
  resume(agentSessionId: string, opts: LaunchOpts): SpawnSpec;
  /** How analytics events are sourced for this harness. */
  eventSource: "hooks" | "transcript-tail";
  /** Resumable sessions for a directory (agent-side history). */
  listPastSessions(cwd: string): Promise<SessionSummary[]>;
  /**
   * Best-effort scrollback check for this harness's own known blocking
   * prompts (e.g. "trust this directory?"), for harnesses whose real
   * readiness signal (SessionStart-equivalent) can't be trusted to arrive
   * before the very first input is worth injecting — see CodexAdapter's
   * implementation for why. Optional: a harness whose readiness signal IS
   * trustworthy standalone (Claude Code's SessionStart hook) should leave
   * this unimplemented rather than have SessionManager fall back to a
   * scrollback heuristic it doesn't need.
   */
  detectBlockingPrompt?(scrollback: string): boolean;
  /**
   * Builds a one-shot, headless invocation for `TaskManager.run()`: executes
   * `opts.prompt` non-interactively and exits on its own when the turn
   * completes — no pty write to submit it and no trust dialog to wait out
   * (see ClaudeCodeAdapter's implementation, verified against a real
   * `claude` binary: `-p` mode fires the same hooks a real session does and
   * skips the trust prompt entirely). Stdout is expected to be line-oriented
   * JSON progress events (see core/task-stream.ts). Optional: a harness with
   * no non-interactive mode simply doesn't support background tasks yet —
   * TaskManager throws a clear error rather than silently misusing `launch`.
   */
  launchTask?(opts: LaunchOpts): SpawnSpec;
}

// ---------------------------------------------------------------------------
// Background tasks (headless one-shot agent runs — see core/task-manager.ts)
// ---------------------------------------------------------------------------

export type BackgroundTaskStatus = "running" | "completed" | "failed";

/**
 * One headless agent run (today: canvas enrichment, spawned on bind or by
 * the visualize macro). Deliberately NOT a HarnessSession: tasks never
 * appear in the session registry (so no tab, no resume, no ghost-record
 * reconciliation to worry about) and live only in TaskManager's memory —
 * the pty-less process exits on its own when its single turn completes.
 */
export interface BackgroundTask {
  /** Our id (uuid). Also used as the task's SAPIOM_HARNESS_SESSION_ID and
   *  its generated-config dir name (covered by the same retention sweep as
   *  real sessions — see core/inject/retention.ts). */
  id: string;
  /** The macro that spawned it (retry re-runs this id). */
  macroId: string;
  /** Display label, e.g. "Visualize". */
  label: string;
  /** The interactive session the macro was triggered from — the canvas pane
   *  showing that session renders this task's live status. */
  harnessSessionId: string;
  cwd: string;
  /** The workflow this task was launched for, when it targets one — the
   *  canvas pane scopes its activity view to the session's CURRENT binding
   *  via this, so switching workflows mid-task never bleeds another
   *  workflow's progress into the pane. Null for workflow-less tasks. */
  workflowPath: string | null;
  status: BackgroundTaskStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  /** Rolling tail of compact human-readable progress lines derived from the
   *  task's stream-json stdout (see core/task-stream.ts), oldest first. */
  statusLines: string[];
  /** The final result event's text when the task completed successfully —
   *  the payload a structured task (canvas enrichment) parses. Null while
   *  running and on failure. */
  resultText: string | null;
  /** On failure: the result error / stderr tail worth showing a user. */
  errorTail: string | null;
}

// ---------------------------------------------------------------------------
// Terminal WebSocket protocol  (/ws/terminal?session=<id>&token=<boot token>)
// ---------------------------------------------------------------------------
//
// Server → client: raw utf8/binary frames are terminal output bytes.
// Client → server: raw utf8 frames are keystrokes EXCEPT frames that parse as
// JSON with a known `type`, which are control messages:

export interface TerminalResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

export type TerminalControlMessage = TerminalResizeMessage;

// ---------------------------------------------------------------------------
// Event-bus WebSocket  (/ws/events?token=<boot token>)  — server → client
// ---------------------------------------------------------------------------

export type BusMessage =
  | { type: "session.status"; session: HarnessSession }
  | { type: "canvas.reload"; harnessSessionId: string }
  | { type: "port.detected"; harnessSessionId: string; port: number; url: string }
  | { type: "workflows.changed" }
  /**
   * Full snapshot of one background task, re-broadcast on every change
   * (spawn, each new status line, completion/failure). Tasks are rare and
   * their records small, so snapshot-per-change beats a separate delta
   * protocol the SPA would have to stitch together after a mid-run mount.
   */
  | { type: "task.status"; task: BackgroundTask }
  /**
   * Best-effort "this session's pty just produced output" signal, throttled
   * server-side to at most once per session per ~2s (see SessionManager's
   * pty.onData handler) — a lightweight substitute for byte-level streaming
   * on /ws/events, which only the session with an open /ws/terminal socket
   * receives. Drives the SPA's per-tab busy pulse for background sessions.
   */
  | { type: "session.activity"; harnessSessionId: string; at: string };

// ---------------------------------------------------------------------------
// Adapter registry (GET /api/harnesses)
// ---------------------------------------------------------------------------

/** One entry in the adapter registry, as the SPA sees it (GET /api/harnesses). */
export interface HarnessEntry {
  /** Stable adapter identifier — one of the known HarnessAdapterId values (e.g. "claude-code", "codex", "conductor"). */
  id: string;
  label: string;
  /** Whether the harness is spawned by the harness server ("embedded") or managed by its own companion app ("external"). */
  mode: "embedded" | "external";
  /** True for adapters whose launch behaviour is not yet hardened by an end-to-end suite. */
  experimental: boolean;
  /** True when the adapter's binary is detected on PATH at request time. */
  installed: boolean;
  /** Per-agent copy-paste instructions for installing and configuring the Sapiom MCP server. */
  installMcpPrompt: string;
}

// ---------------------------------------------------------------------------
// Analytics events
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UI-interaction analytics  (POST /api/track)
// ---------------------------------------------------------------------------

/**
 * Canonical UI event names.  Dot-separated, source "harness", surface marker
 * data.surface: "ui".  These ride the same collector pipeline as hook events
 * (local ndjson always; remote only when opted in), so seq/session dimensions
 * and the analytics-core envelope are added server-side, not client-side.
 * See the collector README section in packages/harness/src/core/collector/
 * for the full surface-"ui" contract.
 */
export type UiEventName =
  | "prompt.submitted"
  | "session.switched"
  | "macro.invoked"
  | "visualize.triggered"
  | "consent.changed"
  | "session.created"
  | "skill.viewed"
  | "skill.used"
  | "mcp.install";

export interface UiTrackRequest {
  /** Dot-canonical event name — one of the UiEventName literals. */
  event: UiEventName;
  /** Arbitrary data payload; server stamps data.surface: "ui" automatically.
   *  Never include prompt text — this is UI-interaction metadata only. */
  data?: Record<string, unknown>;
  /** harnessSessionId to associate this event with (for seq/session dims).
   *  Optional: when omitted, the event gets a synthetic single-use session id.
   */
  harnessSessionId?: string;
}

export const ANALYTICS_SCHEMA_VERSION = 1;

export type AnalyticsEventType =
  | "session.start"
  | "prompt.submitted"
  | "tool.call"
  | "turn.completed"
  | "session.end"
  // UI-interaction analytics (surface: "ui" in payload — see UiEventName):
  | "session.switched"
  | "macro.invoked"
  | "visualize.triggered"
  | "consent.changed"
  | "session.created"
  | "skill.viewed"
  | "skill.used"
  | "mcp.install";

/**
 * The normalized event — the shape that (with opt-in) is batched to the
 * remote collector and always appended to events.ndjson locally.
 * `payload` is deliberately schemaless; it lands in a JSONB column.
 */
export interface AnalyticsEvent {
  eventId: string;
  /** Per-harnessSessionId monotonic counter from 1 — ordering + loss detection. */
  seq: number;
  /** ISO-8601, client clock. Use seq (not ts) for intra-session ordering. */
  ts: string;
  /** Sapiom user id from auth; null when not logged in. */
  userId: string | null;
  /** Sapiom tenant id from auth; null when not logged in. */
  tenantId: string | null;
  machineId: string;
  harnessSessionId: string;
  agentSessionId: string | null;
  harness: HarnessKind;
  type: AnalyticsEventType;
  payload: Record<string, unknown>;
}

/** Static per-install/boot context, sent at batch level. */
export interface CollectorContext {
  harnessVersion: string;
  os: string;
  arch: string;
  nodeVersion: string;
  /** Best-effort agent binary versions, e.g. { "claude-code": "2.0.1" }. */
  agentVersions?: Record<string, string>;
}

/**
 * Batch POSTed to `${SAPIOM_COLLECTOR_URL}/v1/harness/events`.
 * Delivery is at-least-once (3 retries then drop): consumers dedupe on
 * eventId and detect loss via seq gaps. 2xx = accepted; 4xx = drop; 5xx = retry.
 */
export interface CollectorBatch {
  batchId: string;
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION;
  machineId: string;
  sentAt: string;
  context: CollectorContext;
  events: AnalyticsEvent[];
}

// ---------------------------------------------------------------------------
// REST API surface  (all under /api, JSON, boot-token via X-Harness-Token)
// ---------------------------------------------------------------------------
//
// GET    /api/state                     → AppState
// POST   /api/sessions                  CreateSessionRequest → HarnessSession
// GET    /api/sessions                  → HarnessSession[]
// GET    /api/sessions/history?cwd=     → SessionSummary[]
// POST   /api/sessions/:id/resume       → HarnessSession (new pty, --resume)
// DELETE /api/sessions/:id              → { ok: true }   (kill pty)
// POST   /api/sessions/:id/input        InjectInputRequest → { ok: true }
// PATCH  /api/sessions/:id/workflow     BindWorkflowRequest → HarnessSession
// GET    /api/workflows                 → WorkflowInfo[]
// POST   /api/workflows/connect         { path } → WorkflowInfo
// POST   /api/workflows/scan            { root } → WorkflowInfo[]
// GET    /api/macros                    → MacroDef[]
// POST   /api/macros/:id/run            RunMacroRequest → { ok: true }
// GET    /api/settings                  → HarnessSettings
// PATCH  /api/settings                  Partial<HarnessSettings> → HarnessSettings
// POST   /api/sample-project            → SampleProjectSeedResponse (seed/reuse the bundled example)
// GET    /api/fs/list?path=&hidden=     → FsListResponse (directory autocomplete)
// POST   /api/track                     UiTrackRequest → { ok: true }  (UI-interaction analytics)
// POST   /ingest                        (hook payloads; bearer = ingest token)

export interface CreateSessionRequest {
  cwd: string;
  harness: HarnessKind;
  /** Profile id; omit for default. */
  profile?: string;
}

/** Inject text into the session pty (used by macros and the Visualize button). */
export interface InjectInputRequest {
  text: string;
  /** Append a carriage return (submit). Default true. */
  submit?: boolean;
}

/** `PATCH /api/sessions/:id/workflow` body. `null` unbinds. `workflowPath`
 *  must be a path already known to the workflow registry (scan/connect). */
export interface BindWorkflowRequest {
  workflowPath: string | null;
}

/** The trimmed workflow shape embedded in HarnessWorkspaceContext — just
 *  enough for an agent to identify a workflow, not the full WorkflowInfo
 *  (e.g. `source` is registry bookkeeping the agent has no use for). */
export interface HarnessWorkspaceContextWorkflow {
  name: string;
  path: string;
  definitionId: number | null;
}

/**
 * The shape written to HARNESS_CONTEXT_FILE in a session's cwd. Schemaless
 * by convention elsewhere in the harness, but this one file IS a contract —
 * the default system prompt tells the agent to read it, so its shape is
 * fixed here like any other REST payload. Deliberately small and
 * stable-ordered (`workflows` sorted by path) so an agent can diff it
 * cheaply across reads rather than re-parsing a growing blob.
 */
export interface HarnessWorkspaceContext {
  boundWorkflow: HarnessWorkspaceContextWorkflow | null;
  /** Every workflow currently known to this harness instance's registry,
   *  selected or not — lets an agent answer "what workflows exist" without
   *  a UI action, not just "which one is selected." */
  workflows: HarnessWorkspaceContextWorkflow[];
  session: { id: string; cwd: string; harness: HarnessKind };
  updatedAt: string;
}

export interface AppState {
  version: string;
  authenticated: boolean;
  userId: string | null;
  organizationName: string | null;
  telemetryOptIn: boolean;
  /**
   * How telemetry consent was determined at CLI boot. The UI uses this to
   * decide whether to show the first-run notice: "default-silent" means the
   * user never explicitly answered the Y/n prompt (e.g. non-TTY / CI), so
   * we surface a gentle one-time indicator. Optional: omitted by callers that
   * don't run the consent flow (tests, mocks — treated as "stored-explicit"
   * by the UI, i.e. no notice).
   */
  consentSource?: "env-forced-off" | "stored-explicit" | "prompted" | "default-silent";
  /**
   * When consentSource === "env-forced-off", which env var forced it off —
   * rendered in the tracking indicator as "off (env)" with the var name.
   * Null/absent otherwise.
   */
  consentEnvReason?: string | null;
  sessions: HarnessSession[];
  workflows: WorkflowInfo[];
  macros: MacroDef[];
  /** The directory the CLI was launched against — the SPA prefills the
   *  new-session modal with this instead of recentDirs[0]. */
  launchDir: string;
  /** Harness kinds with a working binary on PATH at CLI boot (from doctor()),
   *  in default-preference order — `[0]` is what the auto-created boot
   *  session used. Optional: omitted by callers that construct AppState
   *  without running doctor (tests, mocks); the SPA should treat a missing
   *  value as "assume claude-code is available" until it's wired up. */
  availableHarnesses?: HarnessKind[];
  /** Background tasks known to this server boot (running + recent), so a
   *  page load mid-run shows the canvas activity state immediately instead
   *  of waiting for the next task.status frame. Optional: omitted by callers
   *  without a TaskManager (tests, mocks). */
  tasks?: BackgroundTask[];
  /** True when this boot found no prior harness use on this machine (no
   *  recent directories recorded before this launch). Computed once by the
   *  CLI *before* it records the launch dir / auto-creates the boot session,
   *  and constant for the server's lifetime — the SPA combines it with "no
   *  live sessions" to show the first-run welcome panel instead of a bare
   *  terminal. Optional so AppState constructed without the CLI (tests,
   *  mocks) reads as a returning user by default. */
  firstRun?: boolean;
}

/** `POST /api/sample-project` response — the seeded (or reused) example. */
export interface SampleProjectSeedResponse {
  /** Directory to open a session in — contains the project + its canvas. */
  root: string;
  /** Absolute path of the scaffolded example project inside `root`. */
  projectDir: string;
  /** False when an already-seeded copy was reused as-is. */
  created: boolean;
}

export interface HarnessSettings {
  telemetryOptIn: boolean;
  /** Most-recently-used project directories, newest first. */
  recentDirs: string[];
  /**
   * True once the user has dismissed the first-run telemetry notice
   * (shown when consent was determined silently in a non-TTY environment).
   * Persisted so the notice never appears again after the first dismiss.
   */
  telemetryNoticeDismissed?: boolean;
}

// ---------------------------------------------------------------------------
// Filesystem browsing (new-session directory picker autocomplete)
// ---------------------------------------------------------------------------

export interface FsDirEntry {
  name: string;
  path: string;
}

/**
 * GET /api/fs/list?path= response — directories only, one level deep.
 * `parent` is always a real path, never null: at the filesystem root it
 * equals `path` itself (matches `path.dirname("/") === "/"`), so "no
 * further up" is `parent === path`.
 */
export interface FsListResponse {
  path: string;
  parent: string;
  dirs: FsDirEntry[];
}

// ---------------------------------------------------------------------------
// Workflows (left rail)
// ---------------------------------------------------------------------------

/** An orchestration project on disk, identified by its sapiom.json marker. */
export interface WorkflowInfo {
  /** Directory name (or package.json name when present). */
  name: string;
  /** Absolute path to the project directory (contains sapiom.json). */
  path: string;
  /** From sapiom.json once linked; null before first link. */
  definitionId: number | null;
  /** The deployed agent's slug — the `defineAgent({ name })` that sapiom.json
   *  caches as `name`, used as the executions-API handle
   *  (`/agents/v1/definitions/{slug}/executions`). Null before first link. */
  definitionSlug: string | null;
  /** How it entered the registry. */
  source: "scan" | "connect";
}

// ---------------------------------------------------------------------------
// Action macros (right icon rail)
// ---------------------------------------------------------------------------

/**
 * A macro injects text into the active session's pty, opens a URL, or (the
 * one exception to "always goes through the agent's session") runs the
 * deterministic canvas render + AI enrichment refresh server-side. Template
 * placeholders, substituted server-side before "inject"/"open-url" execution:
 *   {{workflow.path}} {{workflow.name}} {{workflow.definitionId}}
 *   {{session.cwd}}   {{canvas.path}}   {{subject}}
 */
export interface MacroDef {
  id: string;
  label: string;
  /** Lucide icon name rendered in the rail. */
  icon: string;
  action:
    | { kind: "inject"; text: string; submit?: boolean }
    | { kind: "open-url"; url: string }
    /** Force refresh of the bound workflow's canvas: invalidates the
     *  extraction + enrichment caches, re-renders the deterministic diagram
     *  instantly, and re-spawns the bounded AI enrichment task (see
     *  core/canvas-enrich.ts) — no pty involved. A cheap no-op when the
     *  session is unbound. */
    | { kind: "render-canvas" };
  /** Macro requires a selected workflow to be enabled. */
  requiresWorkflow?: boolean;
  /**
   * Where an `"inject"` macro's resolved text runs. Default (omitted /
   * `"inject"`): written into the user's own active session pty, visible in
   * their terminal and occupying their thread — same as always.
   * `"background"`: run headless in a one-shot task process via
   * TaskManager (the user's session is never touched), so a long-running
   * macro can't interrupt whatever the user was doing.
   * Ignored for non-"inject" actions.
   */
  execution?: "inject" | "background";
}

export interface RunMacroRequest {
  harnessSessionId: string;
  /** Selected workflow path, when the macro requires one. */
  workflowPath?: string;
  /** Free-text subject for the visualize macro. */
  subject?: string;
}
