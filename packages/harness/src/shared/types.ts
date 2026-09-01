/**
 * Sapiom Harness — shared interface contract.
 *
 * Every workstream (terminal core, SPA, analytics, CLI, canvas) builds against
 * the types in this file. Change them only by agreement — this file is the
 * integration boundary.
 */

import type {
  SystemGraphLifecycleState,
  WorkspaceKey,
} from "./system-graph.js";

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
  /** Durable Studio project identities and private repository/root bindings. */
  studioProjects: `${HARNESS_HOME}/studio-projects.json`,
  /** Durable plan-first Agent Map records, partitioned beneath projects/. */
  agentMap: `${HARNESS_HOME}/agent-map`,
  /** Generated per-session agent config (claude settings/mcp-config files). */
  generated: `${HARNESS_HOME}/generated`,
  /**
   * Archived session records — one compacted `<harnessSessionId>.json` per
   * conversation (core/record-archive.ts). Deliberately NOT under `generated`:
   * that directory is deleted the moment a session's pty exits, and these have
   * to outlive `events.ndjson`'s 30-day retention, not undercut it.
   */
  records: `${HARNESS_HOME}/records`,
  /** Where the bundled example project is seeded. Written ONLY by
   *  `scripts/seed-example.mjs` (demo prep) since the in-app sample action and
   *  its `POST /api/sample-project` route were removed — the running Studio
   *  neither seeds nor reads this path, so a directory here is leftover output.
   *  Kept stable so re-seeding reuses one copy instead of scattering fresh ones. */
  sampleProject: `${HARNESS_HOME}/sample-project`,
} as const;

/**
 * The file that makes a directory an agent project. Canonical home: three
 * copies of this literal used to live in core/workspace-watcher.ts,
 * core/workflow-registry.ts and (now) server/fs.ts, the first of which carried
 * a "kept in sync with" comment admitting the duplication. Import it.
 */
export const AGENT_PROJECT_MARKER = "sapiom.json";

/**
 * Canvas convention: Studio-owned deterministic renders and optional custom
 * HTML live here, relative to the session cwd. The server watches this
 * directory and serves the active workflow at `/canvas/<harnessSessionId>/`.
 * Deterministic workflow files use `CANVAS_RENDERS_DIR`; `index.html` remains
 * the optional custom-canvas fallback and is never rewritten by that pipeline.
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

/** Renderer-only files are materialized here before their paths are included
 * in a new session's first prompt. Disk-backed attachments never get copied. */
export const HARNESS_UPLOADS_DIR = ".sapiom/uploads";

/** Hard cap for one pathless clipboard attachment after base64 decoding. */
export const MAX_INLINE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Renderer-memory cap across all pathless files queued for one new session. */
export const MAX_INLINE_ATTACHMENTS_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * Body-parser byte limit for JSON `/api` routes, set well above express's
 * 100 KiB default so larger prompt / analytics payloads parse without a 413.
 * Shared by the app-level `/api` parser (server/index.ts) and the rest router
 * so the two can't disagree; every route still validates its own shape.
 */
export const JSON_BODY_LIMIT_BYTES = 15 * 1024 * 1024;

/**
 * Workspace-state convention: Agent Studio mirrors this session's binding,
 * the full agent registry, and its own identity here, relative to the
 * session cwd, so the coding agent has an always-current answer to
 * "what am I working on" and "what agents exist" without asking. Written
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
  /**
   * The app's UI theme at launch, mapped to Claude Code's matching ANSI theme
   * so the terminal palette controls its colors. Persisted so resume reuses the
   * same base. Absent on sessions created before this existed → server default.
   */
  theme?: UiTheme;
  /** Exit code when status === "exited". */
  exitCode?: number | null;
  /**
   * The tail of terminal output captured when the session exited ABNORMALLY
   * (a non-zero `exitCode`). This is the one place the coding agent's own
   * error line survives: a live pty's scrollback is discarded the moment it
   * exits, so without this a session that dies at startup — `claude` rejecting
   * an unknown flag, a failed auth/provider init, a broken hook command —
   * leaves only a bare exit code with no way to tell WHICH of those happened
   * (the "exited before establishing a session id" reports). ANSI escapes are
   * stripped to human-readable text (see `sanitizeExitTail`). Null/absent for
   * a clean exit (code 0), a synthesized/killed exit, a session that produced
   * no readable output, or one persisted by a build from before this existed.
   */
  exitTail?: string | null;
  /** The deployable agent (by path) this session is currently bound to, if any. Set
   *  via `PATCH /api/sessions/:id/workflow`; mirrored into
   *  HARNESS_CONTEXT_FILE in the session's cwd so the coding agent can read it. */
  boundWorkflowPath: string | null;
  /**
   * The prior session this one was seeded from (portable continue — see
   * core/rehydration.ts), when a brief was ACTUALLY produced and delivered.
   * For a trusted planner replacement, this instead names the exact prior
   * HarnessSession whose durable coordinator FIFO was handed off; its brief
   * may come from an older recorded ancestor in the same continuation chain.
   * Null/absent otherwise, including an ordinary client request whose event
   * log contains no usable context. Absent on sessions persisted by builds
   * from before this existed.
   */
  rehydratedFrom?: string | null;
  /**
   * `status === "running"` only means the pty is alive — the agent's TUI
   * can still be sitting on a blocking prompt (most commonly: "trust this
   * directory?") that isn't accepting real input yet. `ready` is the
   * stronger signal: this pty is actually interactive. Reset to `false` on
   * every fresh spawn (including resume) and only ever set by
   * `SessionManager.setReady()` — either from the harness's real lifecycle
   * signal or an explicitly-declared adapter fallback. A fallback may publish
   * readiness before the harness has created its first transcript/rollout;
   * `ready` describes whether the TUI can receive input, not whether durable
   * conversation metadata already exists. Injecting input (macros,
   * `/sessions/:id/input`) against a not-ready session queues briefly then
   * fails loudly (`SessionNotReadyError`) rather than silently writing into a
   * TUI that isn't listening; raw terminal keystrokes (`write()`) are
   * deliberately never gated on this, since a human must always be able to
   * answer the blocking prompt themselves.
   */
  ready: boolean;
  /** Trusted Studio-owned role metadata. Generic POST /sessions cannot set it. */
  planning?: import("./agent-map.js").PlannerSessionMetadata;
}

/**
 * What resuming a past session would ACTUALLY do — resolved server-side
 * against the agent's own conversation store, never guessed from whether we
 * happen to hold an `agentSessionId`.
 *
 * - `agent-resume`: the agent still holds this conversation, so
 *   `HarnessAdapter.resume()` reattaches to it for real.
 * - `rehydrate`: the agent does NOT hold it. Most commonly a session that
 *   ended before its first prompt — Claude Code writes no transcript at all
 *   for those, and Codex writes no rollout file (see CodexAdapter's
 *   `detectBlockingPrompt` for the same rule from the other direction). The
 *   conversation is unrecoverable from the agent; the only honest options are
 *   a fresh session in the same directory, or (once H3 lands) replaying our
 *   own recorded context into one.
 */
export type SessionResumeMode = "agent-resume" | "rehydrate";

/** A past session discovered from agent transcripts or our registry. */
export interface SessionSummary {
  /** Back-reference to our session when the registry tracked it (source "registry"). */
  harnessSessionId?: string;
  agentSessionId: string;
  harness: HarnessKind;
  cwd: string;
  title: string;
  lastActiveAt: string;
  source: "registry" | "transcript";
  /**
   * Whether this row can genuinely be handed back to the agent — verified
   * against the agent's own store by `GET /api/sessions/history`, for BOTH
   * row sources. Holding an `agentSessionId` is not evidence of anything:
   * we capture it from the SessionStart hook, which fires long before the
   * agent has a conversation worth resuming.
   */
  resumeMode: SessionResumeMode;
  /**
   * Git branch the session was last active on, when the transcript records it.
   * The strongest within-directory differentiator between otherwise-similar
   * rows (many sessions in one repo often differ only by branch). Undefined
   * for harnesses/transcripts that don't record a branch.
   */
  gitBranch?: string;
  /**
   * Number of human prompts (turns) in the session, when cheaply knowable.
   * Undefined for transcripts too large to scan for an exact count without a
   * full read (see the claude-code adapter's full-scan size cap).
   */
  messageCount?: number;
  /**
   * Number of human prompts (turns) the harness itself recorded for this
   * session — from the event store's byte-offset index, or from the archived
   * record once the events behind it have been swept. Exact and cheap at any
   * file size — unlike {@link messageCount}, which the claude-code adapter
   * leaves undefined above its full-scan cap. Undefined when the harness has
   * neither events nor an archived record for the session (a transcript the
   * Studio never ran). Prefer this over messageCount when both are present.
   */
  turnCount?: number;
}

/**
 * What an adapter reports having FOUND — everything in a `SessionSummary`
 * except `resumeMode`. Deciding what resuming a row would do is the server's
 * job (`GET /api/sessions/history`), so the adapter contract deliberately
 * can't express it: that's what kept transcript rows hardcoded to
 * un-resumable while registry rows were hardcoded to resumable, each wrong in
 * the opposite direction.
 */
export type PastSessionRecord = Omit<SessionSummary, "resumeMode">;

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
  /**
   * Set by the launch-opts builder when this launch's context was seeded from
   * a prior session's recorded events (portable continue — see
   * core/rehydration.ts). Carries the id the brief was built from. Adapters
   * ignore it entirely; `SessionManager.create()` copies it onto
   * {@link HarnessSession.rehydratedFrom} so the UI can say whether the
   * continue really carried context instead of implying it did.
   */
  rehydratedFrom?: string;
}

/**
 * How a harness receives the rehydration brief for a continued session.
 *
 * - `launch-flag`: the adapter puts `LaunchOpts.systemPromptFile`'s contents in
 *   front of the agent at spawn time (claude-code's `--append-system-prompt`,
 *   codex's `developer_instructions`), so composing the brief into that file is
 *   the whole delivery.
 * - `post-ready-injection`: the harness has no such flag, so the brief is sent
 *   through the ordinary input path once the session reports `ready` — gated on
 *   readiness so it is never written into a TUI sitting on a trust prompt.
 *
 * See `systemPromptDeliveryFor` (core/rehydration.ts) for why the absent case
 * resolves to the fallback rather than the flag.
 */
export type SystemPromptDelivery = "launch-flag" | "post-ready-injection";

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
  /**
   * Whether `launch`/`resume` actually put `LaunchOpts.systemPromptFile` in
   * front of the agent. Declared rather than inferred, because the alternative
   * — assuming every adapter honours the field — silently drops a rehydration
   * brief for one that doesn't. Omitted resolves to `post-ready-injection`
   * (see `systemPromptDeliveryFor` in core/rehydration.ts).
   */
  systemPromptDelivery?: SystemPromptDelivery;
  /** Past sessions this agent recorded for a directory (agent-side history).
   *  Reports what it found; `resumeMode` is the server's call — see
   *  {@link PastSessionRecord}. */
  listPastSessions(cwd: string): Promise<PastSessionRecord[]>;
  /**
   * Does this agent's OWN conversation store still hold `agentSessionId` for
   * `cwd` — i.e. would `resume()` reattach to a real conversation rather than
   * dying on startup?
   *
   * This exists because holding an `agentSessionId` proves nothing: we capture
   * it from the SessionStart hook, which fires before the user has submitted
   * anything, and an agent that never received a prompt writes no transcript
   * at all. Without this check, one in three history rows was a Resume button
   * guaranteed to fail with `No conversation found with session ID: …`.
   *
   * Contract: **never throws**. A missing, unreadable, or empty store is
   * `false` — a resumability probe must not be able to break the history
   * endpoint or `resume()`'s pre-flight.
   */
  canResume(agentSessionId: string, cwd: string): Promise<boolean>;
  /**
   * Best-effort check of recent content-bearing terminal output for this
   * harness's own known blocking prompts (e.g. trust, login, or onboarding
   * screens). Used by declared readiness fallbacks to avoid input while a
   * screen the adapter recognizes is visible; it is not a generic terminal-
   * state guarantee, so adapters are responsible for tracking stable copy
   * from their startup flows. See CodexAdapter for the immediate-fallback
   * case. Optional for adapters that never declare a fallback.
   */
  detectBlockingPrompt?(terminalOutput: string): boolean;
  /**
   * Best-effort positive match for this harness's empty interactive composer.
   * Immediate fallbacks use it only after they previously recognized a
   * blocking screen: a partial TUI repaint cannot erase that blocker latch;
   * a positively identified composer can. Optional when the adapter's output
   * is not diff-rendered or it never declares an immediate fallback.
   */
  detectReadyPrompt?(terminalOutput: string): boolean;
  /**
   * How SessionManager may proactively mark this harness ready WITHOUT its
   * real readiness signal (SessionStart hook / tailer equivalent). Absent =
   * never publish fallback readiness; detect-only legacy adapters retain only
   * their request-time `isReadyEnough` compatibility path.
   *
   *  - `"immediate"` (Codex): after the pty has produced output and settled
   *    (or reached a bounded liveness ceiling), SessionManager proactively
   *    publishes `ready` when no recognized blocking prompt is visible,
   *    releasing a held first prompt. `isReadyEnough` applies the same rule
   *    as a request-time race safeguard. Codex's real signal cannot arrive
   *    before the first injection needs it (see CodexAdapter).
   *  - `"hook-timeout"` (Claude Code): the hook is the primary signal, but a
   *    generously-timed fallback flips `ready` when it never arrives — the
   *    hook chain runs `node` through whatever shell Claude uses for hooks,
   *    and on Windows machines where that resolution breaks, the alternative
   *    was a held first prompt silently dropped. When supplied,
   *    `detectBlockingPrompt` keeps this fallback waiting on blocking screens
   *    the adapter recognizes.
   */
  readyFallback?: "immediate" | "hook-timeout";
  /**
   * Whether this harness's TUI is known to always enable bracketed paste
   * (DEC mode 2004). Used only when the pty's own output never showed a 2004
   * set/reset: ConPTY re-renders output rather than passing DEC private-mode
   * sequences through, so on Windows the observation channel is blind and a
   * multi-line prompt written raw would submit at its first newline. An
   * explicit observed reset still wins over this assumption.
   */
  assumesBracketedPaste?: boolean;
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
  | {
      type: "port.detected";
      harnessSessionId: string;
      port: number;
      url: string;
    }
  /**
   * A run just started (the CLI printed `✓ Started execution <id>`, caught by
   * the ExecutionDetector). The SPA starts polling `/api/runs/:id/state` on
   * receipt. `target` is `"prod"` today — local runs render from their final
   * result rather than polling.
   */
  | {
      type: "execution.started";
      harnessSessionId: string;
      executionId: string;
      target: "prod" | "local";
    }
  | { type: "workflows.changed" }
  | {
      type: "system-graph.changed";
      workspaceKey: WorkspaceKey;
      revision: number;
      state: SystemGraphLifecycleState;
    }
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
  | { type: "session.activity"; harnessSessionId: string; at: string }
  /**
   * Auth state changed — fired after a successful sign-in (`POST
   * /api/auth/start`) or sign-out (`POST /api/auth/disconnect`). The SPA
   * should refetch `/api/auth/status` (or `/api/state`) on receipt to update
   * its auth UI without a full page reload.
   */
  | {
      type: "auth.changed";
      authenticated: boolean;
      organizationName: string | null;
    };

// ---------------------------------------------------------------------------
// Runtime analytics — live run render state (see core/render-run-state.ts)
// ---------------------------------------------------------------------------
//
// The transport-agnostic shape the canvas renders a run from. The server
// produces it (GET /api/runs/:id/state = inspect → decode → renderRunState);
// the web poll loop and canvas consume it. Deliberately DERIVED, never raw:
// every field is computed deterministically from the decoded
// ExecutionProjection — no LLM, no I/O — so the same RunView drives both the
// polling path today and a future WebSocket push (only the source swaps).

/**
 * One capability call a step made during the run. Capability-scoped and
 * provider-agnostic: `capability` is a dotted capability id (e.g.
 * `web.search`, `models.coding.run`) — never a provider or model name.
 * `stubUsed` records whether this call was served by a supplied stub instead
 * of a real capability call, which is the single most load-bearing fact when
 * explaining a local stub-served run. Optional fields are ABSENT (not null)
 * when the source does not carry the value — honest absence.
 */
export interface StepCall {
  /** Dotted capability id (provider-agnostic — never a provider/model name). */
  capability: string;
  /** True when a supplied stub served this call rather than the real capability. */
  stubUsed?: boolean;
  /** The arguments the call was made with, when the source carries them. Any
   *  JSON shape; ABSENT (not null) otherwise. */
  args?: unknown;
  /** The value the call returned — the served stub value for a local run, or
   *  the capability result for a prod run. ABSENT when the source has no result. */
  result?: unknown;
}

/**
 * A step's render status, folded from the raw projection step status into the
 * four states the canvas draws. `cancelled`/`failed` both fold to `failed`
 * (a cancelled step did not pass — mirrors run-local.ts); anything not yet
 * `running`/`passed`/`failed` is `pending`.
 */
export type StepStatus = "pending" | "running" | "passed" | "failed";

/** One step as the canvas renders it — status plus the deterministically
 *  derived latency/error/log slice. Optional fields are ABSENT (not
 *  `undefined`/`0`) when the decoded projection carries no value — honest
 *  absence. Studio exposes every recorded field through the shared evidence
 *  inspector and labels missing fields as not recorded. */
export interface StepView {
  /** Stable id for keyed rendering — the OTel span id, else a step-order key. */
  id: string;
  /** Human step label (the projection's stepName). */
  name: string;
  /** Attempt number from the runtime; retries repeat as distinct rows. Absent
   * only for legacy/synthetic structural rows that predate attempt evidence. */
  attempt?: number;
  status: StepStatus;
  /** Runtime timestamps when recorded. */
  startedAt?: string;
  finishedAt?: string;
  /** finishedAt − startedAt in ms; absent while running or on bad timestamps. */
  latencyMs?: number;
  /** Terminal error message; present only for a failed step that recorded one. */
  error?: string;
  /** Tail-preserving, character-capped executor log text — the debug-macro
   *  context source (trimmed further before injection). Absent when no logs. */
  logSlice?: string;
  /** The resolved input the step actually ran on, when the source carries it
   *  (populated by local stub runs today; a production run projection may
   *  expose it in future). Any JSON shape. ABSENT — never `null`/`{}` — when
   *  the source has no per-step input, so the inspector shows nothing rather
   *  than fabricating a payload. */
  input?: unknown;
  /** The value the step produced, on the same honest-absence terms as
   *  {@link StepView.input}: present only when the source captured a real
   *  output, absent otherwise (a still-running or output-less step shows no
   *  Output block). Any JSON shape. */
  output?: unknown;
  /** Snapshot of shared state immediately after this attempt settled. */
  sharedState?: Record<string, unknown>;
  /** Continue/retry/pause/terminate/fail directive returned by the step. */
  directive?: unknown;
  /** The capability calls this step made during the run, in call order. Each
   *  entry is capability-scoped and provider-agnostic. Absent (never `[]`)
   *  when the source records no call information for this step — honest
   *  absence, mirroring `input`/`output`. A local run populates this from
   *  the stub client's per-call sink; a prod run leaves it absent when the
   *  step projection does not carry dotted-capability call records. */
  calls?: StepCall[];
}

/** A supplied stub key that no capability call ever matched in its step — almost
 *  always a typo or the wrong path form. Surfaced read-only in the inspector so a
 *  no-op mock (a stub that silently served nothing) is visible instead of a
 *  mystery. Mirrors agent-core's `UnusedStub` (consumed as-is). */
export interface UnusedStubView {
  step: string;
  key: string;
}

/** A whole run as the canvas renders it. `status` is the run lifecycle folded
 *  to the four states the UI distinguishes; `steps` is order-preserving.
 *
 *  Stub fields are RUN-LEVEL and honest-absence: they are set only by
 *  {@link renderLocalRun} for a local stub-served run (prod runs from renderRunState
 *  never carry them), and only when they carry real signal. A local run is
 *  stub-served by construction — every `ctx.sapiom.*` call resolves from a stub —
 *  so `stubbed` is the honest per-run truth the inspector marks each executed
 *  step with. When the local trace records individual calls, `StepCall.stubUsed`
 *  supplies the finer-grained attribution alongside that run-level signal.
 *  `unusedStubs`/`stubWarnings`
 *  come from the run's terminal NDJSON summary and are ABSENT (not `[]`) when
 *  empty, so the read-only notice renders nothing when there is nothing wrong. */
export interface RunView {
  executionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  steps: StepView[];
  /** Exact entry input when recorded. */
  input?: unknown;
  /** Canonical terminal output when recorded. */
  output?: unknown;
  /** Canonical terminal error when recorded. */
  error?: unknown;
  startedAt?: string;
  finishedAt?: string;
  /** True when this run was served entirely by stub capabilities. Absent for
   *  real (prod / local-backend) runs. Drives the
   *  per-step "stubbed" chip. */
  stubbed?: boolean;
  /** Supplied stub keys that matched no capability call this run (likely a typo
   *  / wrong path). Absent when none — never an empty array. */
  unusedStubs?: UnusedStubView[];
  /** Human-readable warnings about stub values that matched a key but had the
   *  wrong shape (the silent-wrong-data trap). Absent when none. */
  stubWarnings?: string[];
}

/** Where a run executed — the server announces it on `execution.started`.
 *  "local" runs are stubbed (capabilities run against fixtures); "prod" runs
 *  are real cloud executions.
 *
 *  Lives here rather than in the SPA store because three unrelated consumers
 *  need it: the store, the `execution.started` bus message below, and the
 *  analytics registry — and the analytics module must not import the store
 *  (the store imports IT, so that direction is a cycle). */
export type RunTarget = "prod" | "local";

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
  | "mcp.install"
  | "plan.upgrade_clicked";

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
  | "mcp.install"
  | "plan.upgrade_clicked"
  | "agent_map.workspace_initialized"
  | "agent_map.workspace_read_failed"
  | "planner_session.created"
  | "planner_session.resumed"
  | "planner_session.input_delivery_uncertain"
  | "planner_greeting.attempted"
  | "planner_greeting.delivered"
  | "planner_greeting.failed"
  | "planner_greeting.skipped"
  | "planner_greeting.retried";

/**
 * The normalized event — the shape that (with opt-in) is batched to the
 * remote collector and always appended to events.ndjson locally.
 * `payload` is deliberately schemaless; it lands in a JSONB column.
 */
export interface AnalyticsEvent {
  eventId: string;
  /**
   * Per-harnessSessionId counter from 1, for loss detection *within one
   * process epoch* — NOT a session-lifetime ordering key. The counter lives
   * in the server's memory (core/collector/seq.ts), so it restarts at 1 on
   * every harness boot and on every fresh pty for the same session: a real
   * resumed session reads 1, 2 then 1, 1, 1. A reset means "new epoch", never
   * "events lost". Anything that orders events must sort by `(ts, seq)` —
   * see core/session-record.ts.
   */
  seq: number;
  /** ISO-8601, client clock. Primary ordering key; `seq` only breaks ties. */
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
// Session records (a past session's transcript, rebuilt from OUR events)
// ---------------------------------------------------------------------------
//
// Reconstructed, never verbatim: the source is our own normalized analytics
// events (see core/session-record.ts for the fold), so it works identically
// for claude-code and codex — no vendor transcript file is involved, and
// deleting one changes nothing here. The gaps that follow from that source
// are enumerated in `limitations` so the UI can say so out loud rather than
// implying the record is a full replay.

/** One tool invocation inside a turn, from a `tool.call` event. */
export interface SessionRecordToolCall {
  /** Tool name as the agent reported it; null when the event omitted one. */
  name: string | null;
  /** Stringified tool input (JSON for structured inputs), possibly truncated. */
  input: string | null;
  /** Truncated stringified tool result — see {@link responseTruncated}. */
  responseSummary: string | null;
  /** True when the stored response hit the collector's size cap and the real
   *  output was longer. The missing bytes are not recoverable from our log. */
  responseTruncated: boolean;
  /** ISO-8601 timestamp of the `tool.call` event. */
  at: string;
}

/** One prompt→response turn. A turn opens on `prompt.submitted` and closes on
 *  `turn.completed`; tool calls in between attach to it. */
export interface SessionRecordTurn {
  /** 1-based ordinal in the record — stable for deep links and test asserts. */
  index: number;
  /**
   * The human prompt that opened the turn. Null for a turn our events imply
   * but never saw a prompt for: tool calls or a completion that arrived with
   * no open turn (a session whose recording started mid-turn, or an agent-
   * initiated turn). Rendered as an explicit "no recorded prompt", never faked.
   */
  prompt: string | null;
  /** ISO-8601 timestamp of the opening `prompt.submitted`; null when absent. */
  promptAt: string | null;
  toolCalls: SessionRecordToolCall[];
  /**
   * The assistant's final message for the turn. This is the Stop hook's LAST
   * assistant message only — narration *between* tool calls is not in our
   * event stream (see core/collector/transcript.ts). Null when the harness
   * never captured one (Codex's rollout has no equivalent field).
   */
  assistantText: string | null;
  /** Model that produced the turn, when the transcript backfill supplied it. */
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  /** ISO-8601 timestamp of the closing `turn.completed`; null when open. */
  completedAt: string | null;
  /** True when no `turn.completed` ever closed this turn — the session was
   *  killed mid-turn, or a new prompt superseded it. */
  incomplete: boolean;
}

/**
 * A known, structural gap in a reconstructed record. Codes (not prose) so the
 * UI owns the wording and the set can grow without breaking older clients.
 *
 * - `truncated-tool-output`: at least one tool result hit the collector's size
 *   cap; the full output is not in our log.
 * - `assistant-narration-gap`: a turn has tool calls plus a final assistant
 *   message, so whatever the agent said *between* those calls is missing.
 * - `missing-assistant-text`: a turn completed with no assistant text at all
 *   (Codex, whose rollout carries no equivalent of the Stop hook's field).
 * - `incomplete-final-turn`: the last turn never completed — the session
 *   ended mid-turn.
 * - `compacted-archive`: the record was read from its archived copy, whose
 *   tool inputs and results are clipped to keep it bounded (see
 *   core/record-archive.ts). The conversation is whole; the tool payloads
 *   inside it are excerpts.
 * - `dropped-early-turns`: the archived copy kept only the most recent turns —
 *   `turns` holds fewer of them than `turnCount` says happened.
 */
export type SessionRecordLimitation =
  | "truncated-tool-output"
  | "assistant-narration-gap"
  | "missing-assistant-text"
  | "incomplete-final-turn"
  | "compacted-archive"
  | "dropped-early-turns";

/** `GET /api/sessions/:id/record` response. */
export interface SessionRecord {
  /** The harness session this record was folded from. When several harness
   *  sessions share one agent session (a resumed conversation), this is the
   *  first of them and `mergedSessionIds` lists them all. */
  harnessSessionId: string;
  /** Every harnessSessionId folded into this record, in first-seen order. */
  mergedSessionIds: string[];
  /** The agent's own session id, when our events carried one. */
  agentSessionId: string | null;
  harness: HarnessKind;
  /** cwd from the `session.start` event; null when it never recorded one. */
  cwd: string | null;
  /** ISO-8601 of the earliest event in the record. */
  startedAt: string | null;
  /** ISO-8601 of the `session.end` event; null for a session that never
   *  reported ending (killed, or crashed). */
  endedAt: string | null;
  turns: SessionRecordTurn[];
  /**
   * Human prompts in the CONVERSATION — `turns.filter(t => t.prompt != null)
   * .length` for a record folded from events, and still that same count for an
   * archived record whose oldest turns were dropped to fit its size cap. It
   * describes what happened, not what survived, so a history row's turn count
   * doesn't change when its events get swept; `dropped-early-turns` in
   * {@link limitations} is what says `turns` holds fewer than this.
   */
  turnCount: number;
  /** Events folded into this record (including ones no turn field shows).
   *  Like {@link turnCount}, counted before any archive compaction. */
  eventCount: number;
  /** Always true. Present on the wire so no client can mistake a record for a
   *  verbatim replay of what the user saw in their terminal. */
  reconstructed: true;
  /**
   * ISO-8601 of when this record was written to the durable archive
   * (`~/.sapiom/harness/records/`), or null when it was folded from the live
   * event log. Non-null therefore means "this is the archived copy": bounded,
   * compacted, and — unlike the events — still here after the analytics sink's
   * retention sweep. The UI says so where the user reads it.
   */
  archivedAt: string | null;
  limitations: SessionRecordLimitation[];
}

// ---------------------------------------------------------------------------
// REST API surface  (all under /api, JSON, boot-token via X-Harness-Token)
// ---------------------------------------------------------------------------
//
// GET    /api/state                     → AppState
// POST   /api/sessions                  CreateSessionRequest → HarnessSession
// GET    /api/sessions                  → HarnessSession[]
// GET    /api/sessions/history?cwd=     → SessionSummary[]
// POST   /api/sessions/adopt            AdoptSessionRequest → HarnessSession (register + resume a transcript-only row)
// GET    /api/sessions/:id/record       → SessionRecord (reconstructed transcript)
// POST   /api/sessions/:id/resume       → HarnessSession (new pty, --resume)
// DELETE /api/sessions/:id              → { ok: true }   (kill pty)
// POST   /api/sessions/:id/input        InjectInputRequest → { ok: true }
// POST   /api/sessions/:id/attachments  AttachFileRequest → AttachFileResponse (materialize only)
// PATCH  /api/sessions/:id/workflow     BindWorkflowRequest → HarnessSession
// POST   /api/agents/scaffold           { root, name, template? } → AgentScaffoldResponse (the harness creates the agent)
// POST   /api/agents/move               { from, to } → AgentMoveResponse (rename an agent's directory)
// GET    /api/workflows                 → WorkflowInfo[]
// POST   /api/workflows/connect         { path } → WorkflowInfo
// POST   /api/workflows/scan            { root } → WorkflowInfo[]
// GET    /api/macros                    → MacroDef[]
// POST   /api/macros/:id/run            RunMacroRequest → { ok: true }
// GET    /api/settings                  → HarnessSettings
// PATCH  /api/settings                  Partial<HarnessSettings> → HarnessSettings
// GET    /api/templates                 → TemplateListResponse (relays core's gallery)
// GET    /api/templates/:id             → TemplateDetailView
// GET    /api/account/plan              → AccountPlanView (relays core's plan + usage readout)
// GET    /api/fs/list?path=&hidden=     → FsListResponse (directory autocomplete)
// GET    /api/studio-rail?root=         → StudioRailFileResponse (the rail's stored groups)
// PUT    /api/studio-rail?root=         { raw } → { ok: true }
// DELETE /api/studio-rail?root=         → { ok: true }   (un-materialized = no file)
// GET    /api/studio-rail/launch-edges  → StudioRailLaunchEdgesResponse
// POST   /api/track                     UiTrackRequest → { ok: true }  (UI-interaction analytics)
// POST   /ingest                        (hook payloads; bearer = ingest token)

/**
 * `POST /api/agents/scaffold` response — the agent the harness just created.
 *
 * `path` is SERVER-AUTHORED: the project directory came from the list of
 * folders the rail can show and the name from a validated single segment, so
 * nothing here is the caller's string reflected back. The SPA focuses and binds
 * on this path rather than on the one it asked for.
 */
export interface AgentScaffoldResponse {
  ok: true;
  path: string;
  name: string;
  template: string;
  /** Whether the best-effort `npm install` succeeded. False is not a failure —
   *  the Canvas degrades to its "run npm install" hint. */
  dependenciesInstalled: boolean;
}

/** The app's active UI theme, as tracked client-side (web/src/lib/theme.ts). */
export type UiTheme = "light" | "dark";

export interface CreateSessionRequest {
  cwd: string;
  harness: HarnessKind;
  /** Profile id; omit for default. */
  profile?: string;
  /**
   * Portable continue: seed this fresh session with a reconstruction of a
   * prior one instead of asking the vendor to reattach. Accepts either a
   * `harnessSessionId` or the agent's own session id — whichever the history
   * row carries — and is what a `resumeMode: "rehydrate"` row posts.
   *
   * Best-effort by contract: an id our event log holds nothing for still
   * creates the session, with `HarnessSession.rehydratedFrom` left null so the
   * caller can tell that no context came across. Refusing instead would block
   * the only thing still possible for that row (a fresh session in the same
   * directory) on a summary that was never going to exist.
   */
  rehydrateFrom?: string;
  /**
   * The app's active UI theme when this session was launched. The server maps
   * it to Claude Code's matching ANSI theme (`dark`→`dark-ansi`) so the
   * terminal's own palette controls Claude's colors and its dim text keeps
   * contrast. Persisted on the session so resume reuses the same base. Omitted
   * → server default (see createDefaultBuildLaunchOpts).
   */
  theme?: UiTheme;
}

/** One pathless clipboard file to materialize inside a new session's cwd. */
export interface AttachFileRequest {
  /** `data:<mediaType>;base64,<payload>`. */
  dataUrl: string;
  /** Display name only; the server always owns the stored filename. */
  filename: string;
}

/** Result of materializing a pathless clipboard file. */
export interface AttachFileResponse {
  /** Absolute path beneath the session's `.sapiom/uploads` directory. */
  path: string;
  mediaType: string;
  bytes: number;
}

/**
 * `POST /api/sessions/adopt` body — takes a transcript-only history row (one
 * the registry never tracked, `SessionSummary.harnessSessionId` absent) into
 * the registry and immediately resumes it, so a row whose transcript really is
 * there reattaches to the agent instead of quietly starting a fresh session.
 *
 * The server re-verifies `resumeMode` itself via `HarnessAdapter.canResume`
 * before registering anything — a client claim is never taken on trust, and a
 * `rehydrate` row 409s with `SESSION_NOT_RESUMEABLE` rather than leaving a
 * phantom record behind.
 */
export interface AdoptSessionRequest {
  /** The agent's own conversation id, as reported by `GET /sessions/history`. */
  agentSessionId: string;
  harness: HarnessKind;
  cwd: string;
  /** Display title carried over from the history row. */
  title: string;
  /** When the transcript was last touched — becomes the adopted record's
   *  `createdAt`/`lastActiveAt` so history keeps sorting it where it was. */
  lastActiveAt: string;
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

/** The trimmed agent shape embedded in HarnessWorkspaceContext — just
 *  enough for a coding agent to identify a deployable agent, not the full
 *  internal WorkflowInfo (e.g. `source` is registry bookkeeping it has no
 *  use for). */
export interface HarnessWorkspaceContextAgent {
  name: string;
  path: string;
  definitionId: number | null;
}

/** @deprecated Use {@link HarnessWorkspaceContextAgent}. */
export type HarnessWorkspaceContextWorkflow = HarnessWorkspaceContextAgent;

/**
 * The shape written to HARNESS_CONTEXT_FILE in a session's cwd. Schemaless
 * by convention elsewhere in the harness, but this one file IS a contract —
 * the default system prompt tells the agent to read it, so its shape is
 * fixed here like any other REST payload. Deliberately small and
 * stable-ordered (`agents` sorted by path) so a coding agent can diff it
 * cheaply across reads rather than re-parsing a growing blob.
 */
export interface HarnessWorkspaceContext {
  boundAgent: HarnessWorkspaceContextAgent | null;
  /** Every deployable agent currently known to this Studio instance's
   *  registry, selected or not. */
  agents: HarnessWorkspaceContextAgent[];
  session: { id: string; cwd: string; harness: HarnessKind };
  updatedAt: string;
}

export interface AppState {
  version: string;
  authenticated: boolean;
  userId: string | null;
  /**
   * The Sapiom org/tenant id (SAP-1988). Exposed to the SPA so client PostHog
   * can `group('organization', tenantId)` — segmenting studio usage by customer
   * the same way the web app does. Null when unauthenticated. Today this equals
   * `userId` (identity is org-scoped); kept as a distinct field so a real
   * per-seat id can diverge later without touching the group binding.
   */
  tenantId: string | null;
  organizationName: string | null;
  telemetryOptIn: boolean;
  /**
   * Resolved light-product-analytics (PostHog) opt-in (SAP-1988). Defaults to
   * true (on) when the user hasn't opted out. The SPA gates `posthog` capture
   * on this AND on `consentSource !== "env-forced-off"` (the hard kill-switch,
   * which always wins). Always present so the client never has to distinguish
   * "absent" from "false".
   */
  productAnalyticsOptIn: boolean;
  /**
   * How telemetry consent was determined at CLI boot. The UI uses this to
   * decide whether to show the first-run notice: "default-silent" means the
   * user never explicitly answered the Y/n prompt (e.g. non-TTY / CI), so
   * we surface a gentle one-time indicator. Optional: omitted by callers that
   * don't run the consent flow (tests, mocks — treated as "stored-explicit"
   * by the UI, i.e. no notice).
   */
  consentSource?:
    | "env-forced-off"
    | "stored-explicit"
    | "prompted"
    | "default-silent";
  /**
   * When consentSource === "env-forced-off", which env var forced it off —
   * rendered in the tracking indicator as "off (env)" with the var name.
   * Null/absent otherwise.
   */
  consentEnvReason?: string | null;
  sessions: HarnessSession[];
  workflows: WorkflowInfo[];
  /** Opaque identities for the workspace folders currently known to Studio.
   * Optional for compatibility with older servers and test fixtures. */
  workspaceScopes?: import("./system-graph.js").WorkspaceScopeSummary[];
  /** Path-free durable project identities for the plan-first Agent Map. */
  studioProjects?: import("./agent-map.js").StudioProjectSummary[];
  macros: MacroDef[];
  /** The directory the CLI was launched against — the SPA prefills the
   *  new-session modal with this instead of recentDirs[0]. */
  launchDir: string;
  /**
   * The HOST's default parent directory for NEW agent projects, before the
   * user's `projectRoot` setting overrides it. The server supplies it because
   * only the server knows which host it is running under: the Electron app
   * passes `<launchDir>/projects` (keeping user code out of the state
   * directory's own listing), while the CLI leaves it as `launchDir` — the
   * developer `cd`'d somewhere on purpose.
   *
   * Optional so existing AppState constructors (tests, mocks) stay valid; the
   * SPA falls back to `launchDir`, which is the CLI behaviour anyway.
   */
  defaultProjectRoot?: string;
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
  /** The Agents API base URL this harness resolves and triggers against — the
   *  same env-configurable base the server uses to resolve deployed-agent slugs
   *  (`SAPIOM_AGENTS_URL` / `SAPIOM_TOOLS_BASE`, else the prod default). The
   *  snippet panel renders it as the executions host so the copy-paste cURL/SDK
   *  call hits the same environment the agent was deployed to. Optional: omitted
   *  by callers that construct AppState without the CLI (tests, mocks); the SPA
   *  then falls back to the SDK's own default host. */
  agentsBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Template gallery (relayed from the Sapiom core surface)
// ---------------------------------------------------------------------------

/**
 * The counts a complexity band was derived from, so a surface can explain the
 * band instead of just asserting it. Mirrors core's `TemplateComplexityBasisDto`.
 */
export interface TemplateComplexityBasis {
  /** Steps declared `kind: 'llm'` — each is a judgment point. */
  llmSteps: number;
  /** Model steps feeding directly into another model step (compounding variance). */
  chainedLlmSteps: number;
  /** Media-generation capabilities (image/video). */
  mediaCapabilities: number;
  capabilityCount: number;
  stepCount: number;
  /** Largest number of outgoing targets on any one step. */
  maxFanOut: number;
}

/**
 * How involved a template is, on a 1–5 band derived by core from the template's
 * declared shape. `score` and `label` are redundant on purpose: the score orders
 * and the label reads. A surface renders one of them, never a raw weighted sum —
 * that would invite false precision on what is explicitly a rough estimate.
 *
 * Owned by core's `workflows/template-complexity.ts`. The Studio computes
 * nothing: whether the band is derived (today) or authored (SAP-2086/2087), this
 * type is unchanged and this surface reads whatever core serves.
 */
export interface TemplateComplexity {
  /** 1–5, monotonic in `label`. */
  score: number;
  /** `Minimal` | `Simple` | `Moderate` | `Involved` | `Advanced`. A loose string
   *  for the same reason `category` is: the band vocabulary is owned upstream. */
  label: string;
  basis: TemplateComplexityBasis;
}

/**
 * A gallery card, relayed verbatim from core's `GET /v1/workflows/templates`
 * (`TemplateSummaryDto`). The Studio does NOT own this taxonomy — the registry
 * in the public sapiom-js repo does, and core derives the complexity band from
 * each template's declared shape. Fields are carried through untouched so the
 * Studio's list and the dashboard's Template library can never disagree.
 */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Registry outcome-axis id (`starter`, `revenue-marketing`, …), or null for a
   *  template predating the field. A loose string on purpose: the taxonomy is
   *  owned upstream, so an unrecognised id buckets as uncategorised rather than
   *  dropping the card. */
  category: string | null;
  /** What starts a run (`on-demand` | `scheduled` | `on-webhook` | `on-event`),
   *  or null when undeclared. */
  cadence: string | null;
  stepCount: number;
  /** Dotted catalog capability ids (e.g. `web.search`). */
  capabilities: string[];
  /**
   * How involved the template is. Replaced an estimated per-run cost that core
   * could only compute for a subset of templates; a band is defined for every one.
   *
   * NULLABLE HERE THOUGH CORE TYPES IT REQUIRED, and that is not belt-and-braces.
   * The Studio is a published npm package: an old copy can point at any backend,
   * and a fresh copy can point at a backend that predates the field (a local
   * stack, a self-hosted one, prod before the promotion). Typing it required
   * would put an unguarded dereference in the row renderer and take out the whole
   * dialog. One row degrading to an em dash is the right failure.
   *
   * Note the em dash means something new: it used to be "no cost estimate
   * exists", the majority case; it now means "this response predates the band" —
   * a different claim wearing the same glyph, and one nobody should ever see
   * against a current backend.
   */
  complexity: TemplateComplexity | null;
}

/**
 * One step of a template's declared graph (core's `DefinitionStepDto` subset the
 * detail pane renders).
 *
 * `kind`/`sublabel` come from `classifyStepKind` — the SAME precedence the canvas
 * applies to a real definition — so the preview and the post-clone canvas agree.
 * There is deliberately no `terminal` boolean: the four transition kinds
 * (`continue`/`pause`/`terminate`/`fail`) do not collapse into one, and pretending
 * they do renders a fail-only sink as a green success exit.
 */
export interface TemplateStepView {
  name: string;
  description: string | null;
  capabilities: string[];
  /** Canvas node kind: `entry` | `step` | `pause` | `terminal-success` | `terminal-warn`. */
  kind: string;
  /** One-line role, e.g. `entry`, `step · can also fail`, `terminal · success`. */
  sublabel: string;
}

/** One edge of a template's declared graph (core's `DefinitionTransitionDto`). */
export interface TemplateTransitionView {
  from: string;
  to: string;
  /** The signal a `pause` edge waits for; null for a plain `continue`. */
  label: string | null;
  /** `cross` for a pause edge (as the canvas draws it), else continue flow. */
  kind: "continue" | "pause";
}

/**
 * `GET /api/templates/:id` — the summary plus the rich manifest the detail pane
 * renders. Core expands the registry's hand-authored step list into the same
 * graph shapes a real definition uses, so the preview and the post-clone canvas
 * are the same vocabulary.
 */
export interface TemplateDetailView extends TemplateSummary {
  /** Prose from the co-located `template.json`; null when the manifest omits it. */
  whatItDoes: string | null;
  /** Path inside the sapiom-js repo the fork is seeded from. */
  sourcePath: string | null;
  steps: TemplateStepView[];
  transitions: TemplateTransitionView[];
  author: { name: string; url: string | null } | null;
  useCases: string[];
  /** Markdown. */
  notes: string | null;
  examples: Array<{ title: string | null; input: unknown; output: unknown }>;
  /** Credentials the template needs supplied before a deployed run works. */
  requiredSecrets: Array<{
    key: string;
    label: string;
    description: string | null;
  }>;
}

/**
 * `GET /api/templates` response. `source` tells the SPA whether it is looking at
 * the live catalog or the offline fallback, so the dialog can say so instead of
 * silently presenting two entries as the whole gallery — the failure mode this
 * endpoint exists to fix.
 */
export interface TemplateListResponse {
  templates: TemplateSummary[];
  source: "live" | "fallback";
  /** Why the live fetch was not used, when `source` is `fallback`. */
  reason?: "signed-out" | "unreachable";
}

/**
 * The rail's plan card, assembled SERVER-SIDE from core reads so the SPA never
 * sees the API key and never derives money figures itself (the card renders
 * what it is told or nothing — it does not invent spend, quota, or a plan).
 *
 * `readout` is the one money line the card shows, in preference order:
 *  - `limit`   — today's settled spend against the org's active spend-limit
 *                rule, the same "$used / $cap" pair the dashboard's balance
 *                card renders. Present only when such a rule exists.
 *  - `balance` — the prepaid account's available USD, when no limit rule is
 *                set but the ledger answered.
 *  - `none`    — nothing trustworthy to show; the card omits the line (and
 *                hides entirely when `plan` is also null).
 */
export interface AccountPlanView {
  plan: { name: string; status: "active" | "inactive" } | null;
  readout:
    | { kind: "limit"; usedUsd: number; limitUsd: number }
    | { kind: "balance"; availableUsd: number }
    | { kind: "none" };
  source: "live" | "fallback";
  /** Why the live fetch was not used, when `source` is `fallback`. */
  reason?: "signed-out" | "unreachable";
}

export interface HarnessSettings {
  /**
   * Opt-in to sending the *invasive* usage telemetry to Sapiom → BigQuery
   * (prompts, tool calls, session detail). OFF by default (SAP-1988): a desktop
   * tool that silently ships session content is a reputation risk, so this is
   * opt-in via the setup screen with benefit-framed copy. Distinct from
   * `productAnalyticsOptIn` (light PostHog clicks/journeys, on by default).
   */
  telemetryOptIn: boolean;
  /**
   * Opt-OUT of light product analytics — PostHog autocapture clicks, journeys,
   * and usage metrics with NO recording and NO prompt/user content (SAP-1988).
   * ON by default (absent === true): this is non-invasive and mirrors the web
   * app. Hard kill-switches (`SAPIOM_TELEMETRY_DISABLED` / `DO_NOT_TRACK` /
   * `--no-telemetry`, surfaced as `AppState.consentSource === "env-forced-off"`)
   * always win regardless of this flag.
   */
  productAnalyticsOptIn?: boolean;
  /** Most-recently-used project directories, newest first. */
  recentDirs: string[];
  /**
   * True once the user has dismissed the first-run telemetry notice
   * (shown when consent was determined silently in a non-TTY environment).
   * Persisted so the notice never appears again after the first dismiss.
   */
  telemetryNoticeDismissed?: boolean;
  /**
   * Where NEW agent projects are created (the add-workspace template and idea
   * doors). Absent until the user changes it, in which case the host default
   * (`AppState.defaultProjectRoot`) applies.
   *
   * Deliberately the same value the door itself edits: changing the root while
   * creating a project saves it as the default, so there is one place to set it
   * rather than a door value that silently diverges from a settings value.
   */
  projectRoot?: string;
  /**
   * Opt-in: periodically fold a live session's record into a ≤500-word rolling
   * summary (see core/rolling-summary.ts), which a later portable continue
   * reads to explain what the session was *for* rather than only what it last
   * did. Off by default because it spends tokens on a background LLM call the
   * user never asked for. With it off, briefs degrade to last-N-turns.
   */
  rollingSummary?: boolean;
  /**
   * Which editor "Open in editor" hands the session directory to. Absent means
   * `EDITOR_KINDS[0]` (VS Code) — the behaviour before this setting existed.
   *
   * A preference rather than a detected value: the schemes below are handled by
   * the OS, which never tells us whether anything answered, so a wrong guess is
   * indistinguishable from a working one (the click just does nothing). The user
   * picking their editor is the only signal we can trust.
   */
  editor?: EditorKind;
  /**
   * True once the user has dismissed the first-run "How Studio is organised"
   * explainer (web/src/components/HelpOverlay.tsx).
   *
   * HERE RATHER THAN IN BROWSER STORAGE, and that is the whole point of the
   * field (SAP-2991). "I have already been told what a project is" is a fact
   * about this INSTALL, not about a browser origin — and the desktop app asks
   * the OS for an ephemeral port on every boot, so every launch is a new
   * origin with empty `localStorage`. A one-time card kept there opened every
   * single time. This file is per-install and origin-independent, which is
   * also why `telemetryNoticeDismissed` above lives in it.
   *
   * Still deliberately NOT part of the UI's `ui-prefs` blob: that is the
   * ARRANGEMENT (folds, widths, filing) and a user may reasonably reset it.
   * Having been taught the taxonomy is not an arrangement and must not come
   * back when the arrangement does.
   */
  helpSeen?: boolean;
}

/**
 * The editors "Open in editor" can hand a directory to, in menu order.
 *
 * Each one registers its own URL scheme (`<kind>://file/<path>`) — the VS Code
 * forks kept VS Code's shape, which is why one template covers all of them
 * (see web/src/lib/editors.ts). `HarnessSettings.editor`, the zod enum in
 * server/rest.ts and the picker are all derived from this tuple, so adding an
 * editor is a one-line change here plus its label.
 */
export const EDITOR_KINDS = [
  "vscode",
  "vscode-insiders",
  "cursor",
  "windsurf",
  "zed",
] as const;

export type EditorKind = (typeof EDITOR_KINDS)[number];

// ---------------------------------------------------------------------------
// Filesystem browsing (new-session directory picker autocomplete)
// ---------------------------------------------------------------------------

export interface FsDirEntry {
  name: string;
  path: string;
  /**
   * Whether this directory directly contains AGENT_PROJECT_MARKER.
   *
   * Load-bearing, not decorative: without it a picker cannot tell an agent
   * project from any other folder, so it has to offer every escape hatch
   * (register / scaffold / template / bulk-scan / install-MCP) at all times —
   * which is exactly what made the old add-workspace dialog unusable. With it,
   * those become outcomes of what we found rather than permanent options.
   *
   * Only ONE level deep, matching this endpoint's contract. A `false` here does
   * not mean the subtree is empty of projects — a container folder whose
   * children are projects reports `false` (the rail's recursive scan is the
   * thing that answers "anything under here?").
   */
  hasAgentProject: boolean;
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

/**
 * An agent project known to Studio. It may have been identified by a valid
 * `sapiom.json` marker or by static proof in its regular `index.ts` entrypoint.
 */
export interface WorkflowInfo {
  /** Stable display name, normally the package name or directory name. */
  name: string;
  /** Absolute path to the project directory; a marker is not required. */
  path: string;
  /** Cloud definition id once explicitly linked; null for local-only rows. */
  definitionId: number | null;
  /**
   * Cloud definition slug cached by linking/marker metadata, used as the
   * executions-API handle (`/agents/v1/definitions/{slug}/executions`). This is
   * null for source-only rows; Studio keeps static source identity private.
   */
  definitionSlug: string | null;
  /**
   * Cloud build evidence from the definition-detail projection. An id alone
   * only proves that this local project is linked to a cloud definition;
   * `activeBuildRunStatus === "ready"` is the signal that the definition has a
   * runnable build. Optional for compatibility with older harness servers.
   */
  activeBuildRunId?: string | null;
  activeBuildRunStatus?: string | null;
  /**
   * Provenance from sapiom.json: the gallery template this project was cloned
   * from. Distinct from `source` below, which records how the REGISTRY learned
   * of the path. Optional for compatibility with older harness servers; null
   * when the marker doesn't carry the field.
   */
  templateId?: string | null;
  /** Fork record id from sapiom.json (a gallery clone carries this too). */
  forkId?: string | null;
  /** Bundled-starter id from sapiom.json; `"default"` = bare scaffold. */
  starterId?: string | null;
  /** How it entered the registry. */
  source: "scan" | "connect";
  /**
   * Project-scoped opaque selection identities. An agent can appear beneath
   * overlapping opened roots, so this is a list rather than one global id.
   */
  studioBindings?: Array<{
    projectId: import("./agent-map.js").StudioProjectId;
    agentId: string;
  }>;
}

/**
 * The entry-step contract Studio uses to collect an exact execution input.
 * `unavailable` is deliberately distinct from `none`: the former means
 * extraction failed and Studio must preserve a raw-JSON escape hatch, while
 * the latter means the agent intentionally accepts opaque/no declared input.
 */
export type WorkflowInputContractResponse =
  | {
      status: "available";
      jsonSchema: Record<string, unknown>;
      /** Author example when declared, otherwise a runnable shape skeleton. */
      example: unknown;
    }
  | {
      status: "none";
      jsonSchema: null;
      example: Record<string, never>;
    }
  | {
      status: "unavailable";
      jsonSchema: null;
      example: Record<string, never>;
      /** Safe, user-facing explanation; never raw extraction diagnostics. */
      reason: string;
    };

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
    /** Refresh of the bound workflow's canvas: invalidates the extraction
     *  cache and re-renders the fully deterministic diagram (structure +
     *  derived annotations, no LLM, no user token) — no pty involved. A cheap
     *  no-op when the session is unbound. */
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

/**
 * `GET|PUT|DELETE /api/studio-rail?root=<abs>` — the Group axis's stored
 * arrangement for one project root (`<root>/.sapiom/studio-rail.json`).
 *
 * `raw` is the file's EXACT text, never a decoded object. The file distinguishes
 * `groups: null` ("nothing stored, detection owns this") from `groups: []` ("the
 * user materialized groups and then deleted them all"), and in the reference
 * prototype a second serializer on the write path collapsed the two: every
 * agent fell into `Ungrouped` from the second page load on, permanently. One
 * decoder, in `web/src/lib/agent-groups.ts` — the wire carries text so the
 * server cannot become a second one.
 *
 * `raw: null` = no file. An un-materialized arrangement is written as DELETE,
 * never as a body, so a reset erases the old arrangement instead of letting it
 * outlive the reset.
 */
export interface StudioRailFileResponse {
  /** The resolved absolute project root the blob belongs to. */
  root: string;
  raw: string | null;
}

/** One detected launch edge: `parent` launches `child`. Names as written — the
 *  parent's registry name, the child's `definition` slug at the call site. */
export interface StudioRailLaunchEdge {
  parent: string;
  child: string;
}

/**
 * `GET /api/studio-rail/launch-edges` — every launch edge across the registered
 * agents, from the existing grep in `core/canvas-interconnections.ts` (the same
 * detector the canvas draws its dashed launched-workflow nodes from). The Group
 * axis seeds its groups from the connected components over these.
 */
export interface StudioRailLaunchEdgesResponse {
  edges: StudioRailLaunchEdge[];
}
