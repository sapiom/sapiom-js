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
} as const;

/**
 * Canvas convention: agents write static HTML here, relative to the session
 * cwd. The server watches this directory and serves it at
 * `/canvas/<harnessSessionId>/`.
 */
export const CANVAS_DIR = ".sapiom/canvas";
export const CANVAS_INDEX = `${CANVAS_DIR}/index.html`;

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

export type HarnessKind = "claude-code" | "codex";

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
}

/** A resumable past session discovered from agent transcripts or our registry. */
export interface SessionSummary {
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
  | { type: "workflows.changed" };

// ---------------------------------------------------------------------------
// Analytics events
// ---------------------------------------------------------------------------

export const ANALYTICS_SCHEMA_VERSION = 1;

export type AnalyticsEventType =
  | "session.start"
  | "prompt.submitted"
  | "tool.call"
  | "turn.completed"
  | "session.end";

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
// GET    /api/workflows                 → WorkflowInfo[]
// POST   /api/workflows/connect         { path } → WorkflowInfo
// POST   /api/workflows/scan            { root } → WorkflowInfo[]
// GET    /api/macros                    → MacroDef[]
// POST   /api/macros/:id/run            RunMacroRequest → { ok: true }
// GET    /api/settings                  → HarnessSettings
// PATCH  /api/settings                  Partial<HarnessSettings> → HarnessSettings
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

export interface AppState {
  version: string;
  authenticated: boolean;
  userId: string | null;
  organizationName: string | null;
  telemetryOptIn: boolean;
  sessions: HarnessSession[];
  workflows: WorkflowInfo[];
  macros: MacroDef[];
}

export interface HarnessSettings {
  telemetryOptIn: boolean;
  /** Most-recently-used project directories, newest first. */
  recentDirs: string[];
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
  /** How it entered the registry. */
  source: "scan" | "connect";
}

// ---------------------------------------------------------------------------
// Action macros (right icon rail)
// ---------------------------------------------------------------------------

/**
 * A macro either injects text into the active session's pty or opens a URL.
 * Template placeholders, substituted server-side before execution:
 *   {{workflow.path}} {{workflow.name}} {{workflow.definitionId}}
 *   {{session.cwd}}   {{canvas.path}}   {{subject}}   (Visualize free-text)
 */
export interface MacroDef {
  id: string;
  label: string;
  /** Lucide icon name rendered in the rail. */
  icon: string;
  action:
    | { kind: "inject"; text: string; submit?: boolean }
    | { kind: "open-url"; url: string };
  /** Macro requires a selected workflow to be enabled. */
  requiresWorkflow?: boolean;
}

export interface RunMacroRequest {
  harnessSessionId: string;
  /** Selected workflow path, when the macro requires one. */
  workflowPath?: string;
  /** Free-text subject for the visualize macro. */
  subject?: string;
}
