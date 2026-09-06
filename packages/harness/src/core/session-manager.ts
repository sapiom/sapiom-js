/**
 * SessionManager — node-pty registry implementing the session lifecycle from
 * the shared contract: create, resume, kill, list. Persists HarnessSession[]
 * to disk (HARNESS_PATHS.sessions) so the SPA's session dropdown survives
 * server restarts, even though the ptys themselves do not.
 */

import type { FocusedSessionContextProjection } from "./focused-session-context.js";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";

import {
  ENV,
  HARNESS_PATHS,
  type CreateSessionRequest,
  type HarnessAdapter,
  type HarnessKind,
  type HarnessSession,
  type LaunchOpts,
  type SpawnSpec,
} from "../shared/types.js";
import type {
  ProjectAgentSession,
  ProjectBootstrapMetadata,
} from "../shared/agent-map.js";
import {
  migratePersistedProjectIdentity,
  removeLegacyProjectSessionMetadata,
} from "./project-session-legacy-migration.js";
import { expandHome } from "./paths.js";
import {
  initialBracketedPasteState,
  trackBracketedPaste,
  wrapPaste,
  type BracketedPasteState,
} from "./bracketed-paste.js";
import { HOST_ESBUILD_PIN } from "./asar-path.js";
import { resolveSpawnTarget } from "./spawn-target.js";
import { stripAnsi } from "./strip-ansi.js";
import {
  AdapterNotFoundError,
  AgentSessionIdentityReservedError,
  ExternalHarnessError,
  SessionAlreadyLiveError,
  SessionNotReadyError,
  SessionNotResumeableError,
  SubsessionBindingMismatchError,
  SubsessionFreshRestartForbiddenError,
  UnknownSessionError,
} from "./errors.js";
import { listHarnessAdapters } from "./adapters/registry.js";
import type {
  IngestCredentialProvider,
  IssuedIngestCredential,
} from "./ingest-credentials.js";

export {
  AdapterNotFoundError,
  AgentSessionIdentityReservedError,
  ExternalHarnessError,
  SessionAlreadyLiveError,
  SessionNotReadyError,
  SessionNotResumeableError,
  SubsessionBindingMismatchError,
  SubsessionFreshRestartForbiddenError,
  UnknownSessionError,
} from "./errors.js";

/** An optional server-owned submit guard rejected immediately at the PTY
 * boundary. Generic callers omit the guard and retain existing behavior. */
export class SessionInputGuardRejectedError extends Error {
  constructor(readonly staged: boolean) {
    super("session input authorization changed before submission");
    this.name = "SessionInputGuardRejectedError";
  }
}

export class ProjectSessionScopeUnavailableError extends Error {
  readonly code = "PROJECT_SESSION_SCOPE_UNAVAILABLE";

  constructor(readonly sessionId: string) {
    super("the session's Studio project scope could not be revalidated");
    this.name = "ProjectSessionScopeUnavailableError";
  }
}

function sameProjectAgent(
  left: ProjectAgentSession,
  right: ProjectAgentSession,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.userId === right.userId &&
    left.sessionId === right.sessionId
  );
}

function parseTrustedSubsessionBindingMarker(
  value: unknown,
  expectedSessionId?: string,
): TrustedSubsessionBindingMarker | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "bindingId,incarnation,parentSessionId,projectId,sessionId,spawnEpoch" ||
    ![value.projectId, value.parentSessionId, value.bindingId, value.sessionId].every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 256 &&
        ![...entry].some((character) => {
          const point = character.codePointAt(0) ?? 0;
          return point <= 0x1f || point === 0x7f;
        }),
    ) ||
    (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) ||
    !Number.isSafeInteger(value.incarnation) ||
    (value.incarnation as number) < 1 ||
    !Number.isSafeInteger(value.spawnEpoch) ||
    (value.spawnEpoch as number) < 1
  ) {
    return null;
  }
  return structuredClone(value) as TrustedSubsessionBindingMarker;
}

function sameSubsessionBinding(
  left: TrustedSubsessionBindingMarker,
  right: TrustedSubsessionBindingMarker,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.parentSessionId === right.parentSessionId &&
    left.bindingId === right.bindingId &&
    left.sessionId === right.sessionId &&
    left.incarnation === right.incarnation &&
    left.spawnEpoch === right.spawnEpoch
  );
}

// node-pty is a native module. Load it lazily so a missing/broken prebuild on
// an unsupported platform surfaces as a spawn-time error instead of crashing
// the whole server at import time.
type IPty = import("node-pty").IPty;
type PtyForkOptions = import("node-pty").IPtyForkOptions;
export type PtySpawnFn = (
  file: string,
  args: string[],
  options: PtyForkOptions,
) => IPty;

let defaultSpawn: PtySpawnFn | undefined;
let defaultSpawnError: Error | undefined;

/**
 * node-pty ships prebuilt native binaries (including a tiny `spawn-helper`
 * on macOS/Linux) rather than compiling from source. Observed in the wild:
 * a pnpm-managed install can extract that helper without its executable bit
 * set, which fails every single spawn with an opaque "posix_spawnp failed"
 * — nothing to do with the harness's own code, but fatal to every session
 * launch. Best-effort self-heal before the first real spawn; silently a
 * no-op if the file's missing (wrong platform/arch) or already executable.
 * Exported so scripts/e2e-live.ts's preflight check shares this exact fix
 * instead of duplicating it.
 */
export async function ensureSpawnHelperExecutable(): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const nodePtyPkgJson = createRequire(import.meta.url).resolve(
      "node-pty/package.json",
    );
    const helperPath = join(
      dirname(nodePtyPkgJson),
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await chmod(helperPath, 0o755);
  } catch {
    // Not present for this platform/arch — nothing to fix.
  }
}

async function loadDefaultSpawn(): Promise<PtySpawnFn> {
  if (defaultSpawn) return defaultSpawn;
  if (defaultSpawnError) throw defaultSpawnError;
  try {
    await ensureSpawnHelperExecutable();
    const nodePty = await import("node-pty");
    defaultSpawn = nodePty.spawn as PtySpawnFn;
    return defaultSpawn;
  } catch (err) {
    defaultSpawnError = err instanceof Error ? err : new Error(String(err));
    throw defaultSpawnError;
  }
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Bytes of terminal output retained per session for replay on WS (re)attach. */
const SCROLLBACK_BYTES = 131_072;
/**
 * Readable output preserved from a session that exited ABNORMALLY (see
 * {@link HarnessSession.exitTail}). Enough to hold a startup error banner —
 * "error: unknown option '--plugin-dir'", an auth failure, "Cannot find
 * module …" — without bloating the persisted registry. The live pty's
 * scrollback (up to SCROLLBACK_BYTES) is discarded the instant it exits,
 * taking the coding agent's own error line with it; this is the one place
 * that line survives.
 *
 * Measured in JS string length (UTF-16 code units), matching SCROLLBACK_BYTES
 * — an approximation of bytes that's exact for the ASCII error text this
 * targets and close enough for the rest; the point is a small bound, not a
 * precise byte count.
 */
const EXIT_TAIL_BYTES = 4_096;
/**
 * Delay between writing prompt text and a trailing Enter, when submitting
 * non-empty text in one call (see `submitInput`). Claude Code — like many
 * bracketed-paste-aware TUIs — treats a single write containing both text
 * and a newline as one paste event: the newline lands inside the pasted
 * content instead of registering as a separate "submit" keypress, so the
 * prompt sits in the input box and is never sent. Splitting the write with
 * a short delay makes the terminal see two distinct input events instead —
 * a paste, then a separate Enter.
 *
 * The split alone is a timing guess against the app's own paste heuristic;
 * when the app has bracketed paste on, `submitInput` also marks where the
 * pasted content ends (see `core/bracketed-paste.ts`), which is what makes
 * the Enter a keypress rather than a race. The delay stays either way — it
 * costs one beat and covers apps that debounce their input handling.
 */
const SUBMIT_DELAY_MS = 300;
/** See `kill()`: how long to wait for a graceful exit before escalating to SIGKILL. */
const KILL_ESCALATION_MS = 2_000;
/** See `kill()`: how long after escalating to give node-pty one last chance
 *  to report the exit itself before synthesizing it from an OS-level check. */
const KILL_ESCALATION_CONFIRM_MS = 500;
/**
 * See `isReadyEnough()` / `armReadyFallback()`: how long an immediate-
 * fallback pty must be quiet after its latest content-bearing repaint before
 * the readiness frame can be treated as stable. Anchoring this to the latest
 * visible change (not process spawn) prevents an early banner from winning
 * the race against a trust/login screen that renders a moment later.
 */
const READY_SETTLE_MS = 700;
/**
 * A content-animating TUI may never be quiet for READY_SETTLE_MS, and a
 * malformed/incomplete synchronized-output frame may never close. Do not let
 * either condition deadlock the first prompt forever: once this much time has
 * elapsed since the first visible output, an immediate fallback may bypass
 * the quiet/complete-frame requirement. Recognized blocking prompts still
 * win, so this is a liveness ceiling, not a safety bypass.
 */
const READY_SETTLE_CEILING_MS = 5_000;
/** Codex/Ratatui brackets each atomic terminal repaint in synchronized-output
 *  mode. Treat one such repaint as the readiness frame even when node-pty
 *  splits it across chunks. Pure cursor/style repaints are intentionally
 *  ignored — Codex emits them roughly every 80ms while sitting idle. */
const SYNC_OUTPUT_START = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
/** See `isReadyEnough()` / `armReadyFallback()`: how much of the bounded
 *  recent-frame union to scan for a blocking prompt — not the full history a
 *  full-screen TUI never truly clears. Generous relative to one redraw frame
 *  (confirmed against a real capture: a single Codex trust-prompt frame is
 *  well under 2KB) without re-scanning unbounded history. */
const BLOCKING_PROMPT_SCAN_BYTES = 4_096;
/**
 * See `armReadyFallback()`: how long after spawn a `readyFallback:
 * "hook-timeout"` harness may sit un-ready before the fallback flips it.
 * Generous on purpose: a healthy SessionStart hook lands in 1–3s, so 20s
 * only ever fires when the hook chain is genuinely broken (the Windows
 * node-resolution failure this exists for) — never racing a working hook.
 */
const HOOK_READY_FALLBACK_MS = 20_000;
/** Poll cadence for `armReadyFallback()`'s hook-timeout mode — coarse; nothing user-visible
 *  rides on sub-second precision 20s after spawn. */
const HOOK_READY_POLL_MS = 1_000;
/**
 * See `submitInput()`: how long to wait for a not-yet-ready session to
 * become ready before giving up and throwing `SessionNotReadyError`. Covers
 * the ordinary "macro fired a beat before onboarding finished" case without
 * making a genuinely stuck session (real trust prompt sitting unanswered)
 * hang the caller for long before surfacing something actionable.
 */
const READY_GRACE_MS = 8_000;
/** Poll interval while waiting out READY_GRACE_MS. */
const READY_POLL_MS = 150;
/**
 * Vendor session ids normally remain pinned for the lifetime of a harness
 * session. Claude's trusted `/clear` and `/resume` commands are the two
 * exceptions: both can legitimately cause the next SessionStart hook to
 * report a different id. Keep that exception one-shot and short-lived so a
 * later hook cannot reuse an old user gesture as authority.
 */
const AGENT_SESSION_ROTATION_TTL_MS = 30_000;
/** A picker may reasonably stay open longer than the soft grant. Trusted
 * selection/navigation input refreshes it, but never beyond this hard cap. */
const AGENT_SESSION_PICKER_ROTATION_MAX_MS = 5 * 60_000;
/** Bound raw terminal input retained solely to recognize a trusted command. */
const TRUSTED_INPUT_LINE_MAX = 256;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const AGENT_SESSION_OWNER_FILE_VERSION = 1;
const AGENT_SESSION_OWNER_MAX_ENTRIES = 50_000;
const AGENT_SESSION_OWNER_MAX_BYTES = 4 * 1024 * 1024;
const SUBSESSION_BINDING_FILE_VERSION = 1;
const SUBSESSION_BINDING_MAX_ENTRIES = 8_192;
const SUBSESSION_BINDING_MAX_BYTES = 2 * 1024 * 1024;
/** See `recordActivity()`: minimum gap between two `onActivity` broadcasts
 *  for the same session — pty.onData fires per chunk (often many times a
 *  second for a busy TUI), but the SPA's busy indicator only needs "this
 *  session produced output recently", not every individual chunk. */
const ACTIVITY_BROADCAST_THROTTLE_MS = 2_000;
/**
 * See `sweepDeadSessions()`: how long a non-exited session record may sit
 * with no pty handle at all before the sweep declares it dead. There is one
 * legitimate window where that state exists — inside `create()`/`resume()`,
 * between persisting the record and attaching the freshly-spawned pty (a few
 * awaited config-file writes plus the spawn itself, normally well under a
 * second) — so this just needs to comfortably exceed that window, not be
 * fast: the sweep is a backstop, not the primary reconciliation.
 */
const NO_PTY_SWEEP_GRACE_MS = 30_000;

/**
 * OS-level "does this process exist" check — the same probe `kill()`'s
 * missed-exit fallback has always used, factored out so the liveness sweep
 * shares it. EPERM means the process exists but isn't ours to signal, i.e.
 * alive; anything else (ESRCH) means it's gone.
 */
const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reduce a dying session's raw terminal bytes to the human-readable text worth
 * persisting as {@link HarnessSession.exitTail}: strips ANSI escapes, drops
 * carriage-return redraws and other control bytes, collapses blank runs, and
 * keeps only the final {@link EXIT_TAIL_BYTES}. Best-effort — a window sliced
 * mid-escape can leave a fragment — but the abnormal-exit case it serves is
 * almost always a plain error banner rather than a full-screen TUI, so the
 * common result is clean. Returns null when nothing readable remains, so the
 * UI collapses the section instead of showing an empty box.
 *
 * Exported for direct unit testing.
 */
export function sanitizeExitTail(raw: string): string | null {
  // Only the end can be the tail; bound the work rather than clean a full
  // 128 KB scrollback (a redraw frame is a few KB, so this is ample headroom).
  const cleaned = stripAnsi(raw.slice(-4 * EXIT_TAIL_BYTES))
    .replace(/\r/g, "")
    // Any control bytes stripAnsi left behind (a lone ESC from a truncated
    // sequence, NUL padding), keeping tab and newline.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const trimmed = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(-EXIT_TAIL_BYTES);
}

export type SessionStatusListener = (
  session: HarnessSession,
  context: SessionStatusContext,
) => void;
export type SessionDataListener = (chunk: string) => void;
/** See `onActivity()`. */
export type SessionActivityListener = (harnessSessionId: string) => void;

/**
 * Builds the harness-specific part of LaunchOpts (generated system-prompt /
 * mcp-config / settings file paths). SessionManager owns cwd + harnessSessionId;
 * this lets the server layer inject config-file generation (profiles, MCP
 * wiring) without SessionManager needing to know how those files are produced.
 * May return synchronously or a Promise — generating the config files is
 * inherently async (they're written to disk), so `create()`/`resume()` await
 * whichever shape is handed in; existing sync test doubles keep working
 * unchanged (`await` on a plain value just resolves immediately).
 */
export type LaunchOptsBuilder = (
  harnessSessionId: string,
  req: Pick<
    CreateSessionRequest,
    "cwd" | "harness" | "profile" | "rehydrateFrom" | "theme"
  >,
  context?: {
    promptAppendix?: string;
    focusedContext?: FocusedSessionContextProjection;
    /** Native CLI notice shown before a fresh session's first prompt. */
    sessionStartSystemMessage?: string;
    agentMapIdentity?: ProjectAgentSession;
    /** Server-composed secret launch metadata, never accepted from REST. */
    agentMapMcp?: { url: string; bearerToken: string };
    resume?: boolean;
  },
) =>
  | Omit<LaunchOpts, "harnessSessionId" | "cwd">
  | Promise<Omit<LaunchOpts, "harnessSessionId" | "cwd">>;

const defaultBuildLaunchOpts: LaunchOptsBuilder = () => ({});

export interface SessionManagerOptions {
  adapters: Partial<Record<HarnessKind, HarnessAdapter>>;
  /** Base URL the harness server is reachable at, e.g. http://127.0.0.1:4100. */
  ingestUrl: string;
  /** Per-session capability issuer; shared ingest tokens are not supported. */
  ingestCredentials: IngestCredentialProvider;
  /** Forwarded to sessions as SAPIOM_COLLECTOR_URL when set. */
  collectorUrl?: string;
  /** Absolute path to the session registry file. Defaults to HARNESS_PATHS.sessions (expanded). */
  sessionsPath?: string;
  /** Injectable for tests. Defaults to a lazily-loaded node-pty. */
  spawnPty?: PtySpawnFn;
  /** Async node-pty loader seam used only when `spawnPty` is absent. Production
   * uses the module loader; tests use this to prove authorization is checked
   * after that final await and before PTY admission. */
  loadSpawnPty?: () => Promise<PtySpawnFn>;
  buildLaunchOpts?: LaunchOptsBuilder;
  /** Revalidates cwd containment and current principal before every spawn. */
  resolveAgentMapIdentity?: (
    sessionId: string,
    cwd: string,
    persisted?: ProjectAgentSession,
  ) => Promise<ProjectAgentSession | undefined>;
  /** Claims new-project lifecycle metadata after trusted scope resolution. */
  prepareProjectSession?: (
    identity: ProjectAgentSession,
    request: CreateSessionRequest,
  ) => Promise<{
    initialTitle?: string;
    projectBootstrap?: ProjectBootstrapMetadata;
  }>;
  /** Synchronous notification before a real terminal write crosses the PTY. */
  onTerminalInput?: (sessionId: string, context: TerminalInputContext) => void;
  /** Content-free observability for persisted identity normalization. */
  onProjectAgentIdentityMigration?: (event: {
    sessionId: string;
    outcome: "migrated" | "rejected";
  }) => void;
  /** Registers only sessions that carry a durable bootstrap lifecycle. */
  onProjectBootstrapSession?: (
    session: HarnessSession,
    mode: "created" | "resumed",
    runtimeEpoch: string,
  ) => Promise<void> | void;
  /**
   * Serializes coordinator ownership before a PTY generation is published.
   * `null` retracts a prepared epoch when pre-publication setup fails.
   */
  onRuntimeEpochTransition?: (
    session: HarnessSession,
    runtimeEpoch: string | null,
  ) => Promise<void> | void;
  /** Mirrors an explicit user close into the coordinator-owned aggregate. */
  onSubsessionUserClosed?: (
    marker: TrustedSubsessionBindingMarker,
  ) => Promise<void> | void;
  /** Revokes launch capabilities/transports after every exit path. */
  onAgentMapSessionExit?: (sessionId: string) => void | Promise<void>;
  now?: () => string;
  generateId?: () => string;
  /** Test seam for deterministic registry persistence failures. Production
   * uses the atomic mode-preserving writer below. */
  writeSessionRegistry?: (file: string, serialized: string) => Promise<void>;
  /** Test seam for faults after the private identity ledger becomes durable. */
  writeAgentSessionOwnerRegistry?: (
    file: string,
    serialized: string,
  ) => Promise<void>;
  /** Fault-injection seam for the private coordinator ownership sidecar. */
  writeSubsessionBindingRegistry?: (
    file: string,
    serialized: string,
  ) => Promise<void>;
  /**
   * Writes HARNESS_CONTEXT_FILE for a session — the caller (server/index.ts's
   * `writeSessionContext`) owns resolving the session's `boundWorkflowPath`
   * against the live workflow registry and serializing the full workspace
   * state; this layer just decides *when* to call it. Called unconditionally
   * from `create()`, before the pty is spawned, so every session gets the
   * file regardless of entry point (REST, `autoCreateSession`) — no entry
   * point can skip it by calling `create()` directly. Defaults to a no-op so
   * tests that pass a fake `cwd` (e.g. `/tmp/proj`) never touch the real
   * filesystem unless they opt in.
   */
  writeWorkspaceContext?: (session: HarnessSession) => Promise<void>;
  /**
   * Validates or migrates HARNESS_CONTEXT_FILE before a resumed coding agent
   * is spawned. The caller owns the current/legacy/invalid/missing schema
   * policy and live registry resolution; this layer guarantees the operation
   * is awaited in the same pre-spawn window as the regenerated system prompt.
   * Defaults to a no-op for filesystem-free unit tests.
   */
  prepareWorkspaceContext?: (session: HarnessSession) => Promise<void>;
  /**
   * Drops the canvas kit template into `<cwd>/.sapiom/canvas/index.html`
   * when nothing is there yet (backfill-only — the real implementation,
   * `ensureCanvasTemplate` from core/canvas-template.ts, does its own
   * existence check internally, so unlike `writeWorkspaceContext` this
   * needs no separate `*Exists` companion). Called from both `create()` and
   * `resume()` so the canvas pane is never a blank iframe, regardless of
   * entry point. Defaults to a no-op so tests that pass a fake `cwd` never
   * touch the real filesystem unless they opt in.
   */
  ensureCanvasTemplate?: (cwd: string) => Promise<void>;
  /**
   * Injectable for tests (fake ptys carry fake pids that must never be
   * probed against real OS processes). Defaults to `defaultIsPidAlive`.
   */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Host platform, injectable so the Windows-only bracketed-paste assumption
   * (see `submitInput`) is provable from POSIX CI. Defaults to the real one.
   */
  platform?: NodeJS.Platform;
}

export interface TrustedSessionCreateOptions {
  /** Future E5 seam for a server-authored planned builder assignment. */
  agentMapIdentity?: (sessionId: string) => ProjectAgentSession;
  /** Server-owned initial title. Generic POST /sessions cannot set it. */
  initialTitle?: string;
  /** Focused trusted context composed into the existing system prompt. */
  promptAppendix?: (sessionId: string) => string;
  /** Optional output of serializeFocusedSessionContext; valid only for a project-agent session. */
  focusedContext?: (sessionId: string) => FocusedSessionContextProjection;
  /** Server-authored native CLI orientation for a newly created session. */
  sessionStartSystemMessage?: (sessionId: string) => string;
  /** Server-owned coordinator predecessor. This may differ from the older
   * history record used to build the rehydration brief. */
  handoffFromSessionId?: string;
  /** Internal auto-create guard. Ordinary/user-requested creates omit this and
   * remain valid even when the project's first-session lifecycle already has
   * an owner. */
  requireProjectBootstrapClaim?: boolean;
}

export interface TrustedSessionResumeOptions {
  /** Recomputed focused context for the resumed process. */
  promptAppendix?: string;
  /** Optional output of serializeFocusedSessionContext; valid only for a project-agent session. */
  focusedContext?: FocusedSessionContextProjection;
  /** Private two-sided coordinator transition, never accepted by REST. */
  subsessionBindingTransition?: Readonly<{
    expected: TrustedSubsessionBindingMarker;
    next: TrustedSubsessionBindingMarker;
  }>;
}

interface PtyHandle {
  pty: IPty;
  /** Server-owned identity for this exact live PTY generation. */
  runtimeEpoch: string;
  buffer: string;
  /** Latest content-bearing terminal repaint used for current-screen checks.
   * Unlike `buffer`, animation-only ANSI churn cannot evict the visible text. */
  readinessBuffer: string;
  /** Bounded union of recent content-bearing repaints. Ratatui redraws only
   * changed rows, so one atomic frame does not necessarily describe the whole
   * screen; this history lets multi-phrase prompt signatures span those diffs. */
  readinessHistory: string;
  /** A detected blocking screen remains latched across partial repaints until
   * the adapter positively identifies its empty interactive composer. */
  blockingPromptSeen: boolean;
  /** Possible beginning of a synchronized-output marker split across chunks. */
  pendingReadinessPrefix: string;
  /** Synchronized repaint being assembled across node-pty chunks. */
  pendingReadinessFrame: string | null;
  /** Whether the pending synchronized repaint has produced visible text. */
  pendingReadinessFrameHasContent: boolean;
  emitter: EventEmitter;
  /** Epoch ms this pty was spawned — anchors the Claude hook-timeout fallback. */
  spawnedAt: number;
  /** Epoch ms the current non-blocking readiness candidate began. A recognized
   * blocker resets it so an expired ceiling cannot promote the next screen. */
  readinessCandidateAt: number | null;
  /** Epoch ms of the latest content-bearing repaint, or null until one draws. */
  lastOutputAt: number | null;
  /**
   * Whether the app running in this pty has bracketed paste (DEC mode 2004)
   * on, folded from its own output — see `submitInput` and
   * `core/bracketed-paste.ts`. Read off the stream rather than assumed so a
   * harness that never enables the mode is never fed escape sequences it
   * would render as literal text.
   */
  bracketedPaste: BracketedPasteState;
  /** Bounded, server-observed terminal line used to recognize `/clear` and
   * `/resume`. Hook payloads and ingest credentials can never populate it. */
  trustedInputLine: string;
  /** Once an unsupported control/paste or oversized line is observed, that
   * line cannot authorize identity rotation; Enter resets the condition. */
  trustedInputInvalid: boolean;
  /** Input-side bracketed-paste framing is independent from the app's
   * output-side mode announcement. Both marker and content may span chunks. */
  trustedInputPasting: boolean;
  trustedInputEscape: string;
  /** One-shot authority for the matching SessionStart transition. It lives on
   * the pty handle so exit/relaunch clears it without durable ambient state. */
  agentSessionRotation: {
    source: "clear" | "resume";
    expiresAt: number;
    hardExpiresAt: number;
    refreshOnInput: boolean;
  } | null;
  /**
   * Resolves when this specific pty handle's session has fully exited —
   * either via node-pty's real `onExit` event OR a synthesized exit (kill()'s
   * escalation fallback, sweepDeadSessions, or pre-pty failure reconciliation).
   * `markExited()` is the single convergence point for all three paths, so
   * awaiting `exited` never hangs regardless of which path fires first.
   *
   * Always tied to THIS handle instance: markExited() is idempotent on the
   * handle identity, so a stale duplicate call (e.g. from a late liveness
   * sweep after kill()'s own fallback already ran) is a silent no-op and
   * never resolves a DIFFERENT session's promise.
   */
  exited: Promise<void>;
  /** Internal resolver — called exactly once by markExited(). */
  resolveExited: () => void;
  /**
   * Set by `kill()` before it signals the pty, so `markExited()` knows this
   * death was intentional and skips the exit-tail capture. A session the user
   * closed is not a crash to diagnose — and node-pty can report a non-zero
   * code for a signalled process (e.g. 143 = 128 + SIGTERM on some platforms),
   * which would otherwise be mistaken for an abnormal exit worth a tail.
   */
  killed: boolean;
}

export type AdapterIdentityState =
  | "not-required"
  | "pending"
  | "ready"
  | "ambiguous"
  | "unavailable";


export interface SessionStatusContext {
  /** Exact live/retiring PTY generation, or null before a PTY exists. */
  runtimeEpoch: string | null;
}


export interface TerminalInputContext {
  /** Server-owned identity of the exact PTY receiving these bytes. */
  runtimeEpoch: string;
  /** The current adapter screen is a recognized trust/login/setup blocker. */
  blockingPrompt: boolean;
}


export type TrackedSessionInputResult = Readonly<{
  accepted: boolean;
  phase: SessionInputWritePhase;
  error?: unknown;
}>;

/** Server-private half of a coordinator/session ownership proof. */
export type TrustedSubsessionBindingMarker = Readonly<{
  projectId: string;
  parentSessionId: string;
  bindingId: string;
  sessionId: string;
  incarnation: number;
  spawnEpoch: number;
}>;


export type SessionInputWritePhase =
  | "not-written"
  | "text-staged"
  | "enter-written";


export interface SessionInputWriteLifecycle {
  /** Durable transition that must commit before the first PTY byte. */
  beforeFirstWrite?: () => Promise<void>;
  /** Synchronous final admission fence checked immediately before each write. */
  canWriteNow?: () => boolean;
  /** Durable positive evidence that the writer returned before attempting
   * Enter. Errors at the Enter write are intentionally excluded. */
  onNotSubmitted?: () => Promise<void>;
  /** Synchronous byte-boundary observation for durable delivery recovery. */
  onWritePhase?: (phase: SessionInputWritePhase) => void;
}


/** A prior partial PTY write could not be safely removed from the composer. */
export class SessionInputIsolationError extends Error {
  readonly code = "SESSION_INPUT_ISOLATION_REQUIRED";

  constructor() {
    super("session input is blocked until the terminal composer is reset");
    this.name = "SessionInputIsolationError";
  }
}


export class SessionManagerClosingError extends Error {
  readonly code = "SESSION_MANAGER_CLOSING";

  constructor() {
    super("session manager is shutting down");
    this.name = "SessionManagerClosingError";
  }
}


/** A real terminal write preempted a lower-priority background injection. */
export class SessionBackgroundInputPreemptedError extends Error {
  readonly code = "SESSION_BACKGROUND_INPUT_PREEMPTED";

  constructor(readonly staged: boolean) {
    super("background session input was preempted by user input");
    this.name = "SessionBackgroundInputPreemptedError";
  }
}


export class SessionManager {

  /**
   * Internal tracked variant for retry-safe coordinator delivery. It never
   * turns an ambiguous write exception into zero-byte proof: callers receive
   * the furthest phase observed at the exact PTY boundary.
   */
  async submitInputTracked(
    id: string,
    text: string,
    options: Readonly<{
      canWrite?: () => boolean | Promise<boolean>;
      lifecycle?: Omit<SessionInputWriteLifecycle, "onWritePhase">;
      background?: boolean;
    }> = {},
  ): Promise<TrackedSessionInputResult> {
    let phase: SessionInputWritePhase = "not-written";
    try {
      const accepted = await this.submitInput(
        id,
        text,
        true,
        options.canWrite,
        options.background ?? true,
        {
          ...options.lifecycle,
          onWritePhase: (next) => {
            phase = next;
          },
        },
      );
      return { accepted, phase };
    } catch (error) {
      return { accepted: false, phase, error };
    }
  }


  /**
   * Cancel only a lower-priority server-owned background submission. Unlike
   * write(), this does not forward bytes or preempt an ordinary user/API
   * submission. It is safe to call before staging begins; the coordinator's
   * submit guard covers that side of the race.
   */
  preemptBackgroundInput(id: string): boolean {
    const staged = this.stagedInputs.get(id);
    if (!staged?.background || staged.preempted) return false;
    staged.preempted = true;
    if (staged.textWritten) {
      if (this.abandonStagedLine(staged.handle)) {
        staged.lineCleared = true;
      }
    }
    return true;
  }


  /** Abandon a fully staged line. Ctrl-C is a safe fallback here because a
   * successful full bracketed-paste write already carried its closing marker. */
  private abandonStagedLine(handle: PtyHandle): boolean {
    try {
      handle.pty.write("\x15");
      this.observeTrustedTerminalInput(handle, "\x15");
      return true;
    } catch {
      try {
        handle.pty.write("\x03");
        this.observeTrustedTerminalInput(handle, "\x03");
        return true;
      } catch {
        this.markComposerUnsafe(handle, false);
        return false;
      }
    }
  }


  /**
   * Recover only a previously poisoned composer, before any new user or
   * server-owned text is written. Closing bracketed paste (when required) and
   * abandoning the line are both non-submitting operations. Failure leaves
   * the handle poisoned and no caller payload is forwarded.
   */
  private resetUnsafeComposer(handle: PtyHandle): boolean {
    const unsafe = this.unsafeComposers.get(handle);
    if (!unsafe) return true;
    if (this.closing) return false;
    let pasteMayBeOpen = unsafe.pasteMayBeOpen;
    if (pasteMayBeOpen) {
      try {
        handle.pty.write(BRACKETED_PASTE_END);
        this.observeTrustedTerminalInput(handle, BRACKETED_PASTE_END);
        pasteMayBeOpen = false;
      } catch {
        return false;
      }
    }
    try {
      handle.pty.write("\x15");
      this.observeTrustedTerminalInput(handle, "\x15");
    } catch {
      this.unsafeComposers.set(handle, { pasteMayBeOpen });
      return false;
    }
    this.unsafeComposers.delete(handle);
    return true;
  }


  private markComposerUnsafe(
    handle: PtyHandle,
    pasteMayBeOpen: boolean,
  ): void {
    const current = this.unsafeComposers.get(handle);
    this.unsafeComposers.set(handle, {
      pasteMayBeOpen: current?.pasteMayBeOpen === true || pasteMayBeOpen,
    });
  }


  /** Close admission before a server shutdown snapshots live PTYs. */
  beginShutdown(): void {
    this.closing = true;
  }


  /** Kill only the exact PTY generation a losing coordinator created. */
  killIfRuntime(id: string, runtimeEpoch: string): Promise<boolean> {
    if (this.ptys.get(id)?.runtimeEpoch !== runtimeEpoch)
      return Promise.resolve(false);
    return this.kill(id);
  }


  /**
   * Fail-closed admission for already-authenticated ingest work. A terminal
   * event may finish after its PTY retires, but a replacement handle always
   * takes ownership immediately and rejects every earlier epoch.
   */
  acceptsIngestRuntimeEpoch(id: string, runtimeEpoch: string): boolean {
    const live = this.ptys.get(id);
    if (live) return live.runtimeEpoch === runtimeEpoch;
    return (
      this.sessions.get(id)?.status === "exited" &&
      this.retiredRuntimeEpochs.get(id) === runtimeEpoch
    );
  }


  /** True only for the exact PTY generation that is live right now. */
  isCurrentRuntimeEpoch(id: string, runtimeEpoch: string): boolean {
    const live = this.ptys.get(id);
    return live?.runtimeEpoch === runtimeEpoch;
  }


  /** Server-only acknowledgement from an adapter-owned identity broker. */
  setAdapterIdentityState(
    id: string,
    runtimeEpoch: string,
    state: Exclude<AdapterIdentityState, "not-required" | "pending">,
  ): boolean {
    const current = this.adapterIdentityStates.get(id);
    if (!current || current.runtimeEpoch !== runtimeEpoch ||
        !this.isCurrentRuntimeEpoch(id, runtimeEpoch)) return false;
    current.state = state;
    return true;
  }


  /** Exact-runtime adapter identity used by trusted background delivery. */
  getAdapterIdentityState(id: string, runtimeEpoch: string): AdapterIdentityState {
    const state = this.adapterIdentityStates.get(id);
    if (!state || state.runtimeEpoch !== runtimeEpoch) return "pending";
    return state.state;
  }


  /** Opaque identity for the exact live PTY generation behind `id`. */
  getRuntimeEpoch(id: string): string | null {
    return this.ptys.get(id)?.runtimeEpoch ?? null;
  }

  private closing = false;

  /** Handle-local poison from a partial write whose composer cleanup could not
   * be proven. A replacement PTY is clean by construction; the same handle
   * must complete this reset before any later text or Enter is allowed. */
  private readonly unsafeComposers = new WeakMap<
    PtyHandle,
    { pasteMayBeOpen: boolean }
  >();

  /** One text→Enter transaction may be staged per session. */
  private readonly stagedInputs = new Map<
    string,
    {
      handle: PtyHandle;
      background: boolean;
      preempted: boolean;
      textWritten: boolean;
      lineCleared: boolean;
    }
  >();

  /** Monotonic raw-input observations used to preempt background injection. */
  private readonly terminalInputEpochs = new Map<string, number>();

  /** Adapter-owned correlation for transcript-backed runtimes. This is kept
   * separate from terminal readiness: a TUI can be interactive before its
   * exact vendor transcript has been identified. */
  private readonly adapterIdentityStates = new Map<
    string,
    { runtimeEpoch: string; state: AdapterIdentityState }
  >();

  /** Last cleanly retired PTY generation. It may finish already-admitted ingest
   * work while the session is exited, but loses immediately to a replacement. */
  private readonly retiredRuntimeEpochs = new Map<string, string>();

  private readonly onRuntimeEpochTransition: SessionManagerOptions["onRuntimeEpochTransition"];
  private readonly onSubsessionUserClosed: SessionManagerOptions["onSubsessionUserClosed"];

  private readonly onTerminalInput: (
    sessionId: string,
    context: TerminalInputContext,
  ) => void;

  private readonly loadSpawnPty: () => Promise<PtySpawnFn>;

  private readonly issueIngestCredential: (
    sessionId: string,
  ) => IssuedIngestCredential;

  private readonly adapters: Partial<Record<HarnessKind, HarnessAdapter>>;
  private readonly ingestUrl: string;
  private readonly revokeIngestToken: (sessionId: string) => void;
  private readonly collectorUrl: string | undefined;
  private readonly sessionsPath: string;
  /** Server-private, digest-only tombstones for every vendor identity ever
   * accepted by a HarnessSession. Keeping this outside sessions.json avoids
   * leaking historical aliases through the browser DTO. */
  private readonly agentSessionOwnersPath: string;
  /** Never projected through REST; public session fields are not ownership. */
  private readonly subsessionBindingsPath: string;
  private readonly spawnPty: PtySpawnFn | undefined;
  private readonly buildLaunchOpts: LaunchOptsBuilder;
  private readonly resolveAgentMapIdentity: SessionManagerOptions["resolveAgentMapIdentity"];
  private readonly onProjectAgentIdentityMigration: SessionManagerOptions["onProjectAgentIdentityMigration"];
  private readonly rejectedProjectSessionMetadata = new Set<string>();
  private readonly onAgentMapSessionExit: SessionManagerOptions["onAgentMapSessionExit"];
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly writeSessionRegistry:
    | ((file: string, serialized: string) => Promise<void>)
    | undefined;
  private readonly writeAgentSessionOwnerRegistry:
    | ((file: string, serialized: string) => Promise<void>)
    | undefined;
  private readonly writeSubsessionBindingRegistry:
    | ((file: string, serialized: string) => Promise<void>)
    | undefined;
  private readonly writeWorkspaceContext: (
    session: HarnessSession,
  ) => Promise<void>;
  private readonly prepareWorkspaceContext: (
    session: HarnessSession,
  ) => Promise<void>;
  private readonly ensureCanvasTemplate: (cwd: string) => Promise<void>;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly platform: NodeJS.Platform;

  private readonly sessions = new Map<string, HarnessSession>();
  private readonly ptys = new Map<string, PtyHandle>();
  private readonly statusEmitter = new EventEmitter();
  private readonly activityEmitter = new EventEmitter();
  /** Epoch ms of the last `onActivity` broadcast per session — see `recordActivity()`. */
  private readonly lastActivityBroadcast = new Map<string, number>();
  private writeQueue: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  /** While a vendor-pointer/add-row transaction is committing its private
   * candidate snapshot, every ordinary registry write waits here and captures
   * state only after the candidate was published or rejected. */
  private sessionRegistryIdentityFence: Promise<void> | null = null;
  private readonly agentSessionOwners = new Map<string, string>();
  private readonly subsessionBindings = new Map<
    string,
    TrustedSubsessionBindingMarker
  >();
  private readonly userClosedSubsessions = new Set<string>();
  /** Serializes the full authorize -> reserve -> pointer commit transition.
   * A file-level atomic rename alone is insufficient when two starts race the
   * in-memory ownership check before either write begins. */
  private agentSessionIdentityQueue: Promise<void> = Promise.resolve();
  private agentSessionOwnerWriteSeq = 0;
  private subsessionBindingWriteSeq = 0;
  private subsessionBindingQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options: SessionManagerOptions) {
    this.adapters = options.adapters;
    this.ingestUrl = options.ingestUrl;
    this.issueIngestCredential = (sessionId) =>
      options.ingestCredentials.issue(sessionId);
    this.revokeIngestToken = (sessionId) =>
      options.ingestCredentials.revoke(sessionId);
    this.collectorUrl = options.collectorUrl;
    this.sessionsPath = expandHome(
      options.sessionsPath ?? HARNESS_PATHS.sessions,
    );
    this.agentSessionOwnersPath = `${this.sessionsPath}.agent-session-owners.json`;
    this.subsessionBindingsPath = `${this.sessionsPath}.subsession-bindings.json`;
    this.spawnPty = options.spawnPty;
    this.loadSpawnPty = options.loadSpawnPty ?? loadDefaultSpawn;
    this.buildLaunchOpts = options.buildLaunchOpts ?? defaultBuildLaunchOpts;
    this.resolveAgentMapIdentity = options.resolveAgentMapIdentity;
    this.prepareProjectSession = options.prepareProjectSession;
    this.onAgentMapSessionExit = options.onAgentMapSessionExit;
    this.onTerminalInput = options.onTerminalInput ?? (() => {});
    this.onProjectAgentIdentityMigration =
      options.onProjectAgentIdentityMigration;
    this.onProjectBootstrapSession = options.onProjectBootstrapSession;
    this.onRuntimeEpochTransition = options.onRuntimeEpochTransition;
    this.onSubsessionUserClosed = options.onSubsessionUserClosed;
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
    this.writeSessionRegistry = options.writeSessionRegistry;
    this.writeAgentSessionOwnerRegistry =
      options.writeAgentSessionOwnerRegistry;
    this.writeSubsessionBindingRegistry =
      options.writeSubsessionBindingRegistry;
    this.writeWorkspaceContext =
      options.writeWorkspaceContext ?? (async () => {});
    this.prepareWorkspaceContext =
      options.prepareWorkspaceContext ?? (async () => {});
    this.ensureCanvasTemplate =
      options.ensureCanvasTemplate ?? (async () => {});
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.platform = options.platform ?? process.platform;
    // Many WS clients (terminal + events) can subscribe over a long-running process.
    this.statusEmitter.setMaxListeners(0);
    this.activityEmitter.setMaxListeners(0);
  }

  /**
   * Loads the persisted registry. Any session left "starting"/"running" from
   * a previous process is marked "exited" — ptys don't survive a restart.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    let persisted: HarnessSession[] = [];
    try {
      const raw = await readFile(this.sessionsPath, "utf8");
      persisted = JSON.parse(raw) as HarnessSession[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    let dirty = false;
    for (const session of persisted) {
      const migration = migratePersistedProjectIdentity(session);
      if (migration.outcome === "rejected") {
        this.rejectedProjectSessionMetadata.add(session.id);
      }
      if (migration.outcome === "migrated") {
        if (migration.identity) {
          session.agentMapIdentity = structuredClone(migration.identity);
        } else {
          delete session.agentMapIdentity;
        }
        if (migration.bootstrap) {
          session.projectBootstrap = structuredClone(migration.bootstrap);
        } else {
          delete session.projectBootstrap;
        }
        // Planner-era metadata is never live authority after normalization.
        // Its on-disk input queue is migrated by ProjectBootstrapCoordinator.
        removeLegacyProjectSessionMetadata(session);
        dirty = true;
      }
      if (migration.outcome !== "unchanged") {
        try {
          this.onProjectAgentIdentityMigration?.({
            sessionId: session.id,
            outcome: migration.outcome,
          });
        } catch {
          // Observability is best effort and cannot affect session recovery.
        }
      }
      if (session.status !== "exited") {
        session.status = "exited";
        session.exitCode = session.exitCode ?? null;
        dirty = true;
      }
      // Drop a persisted binding that points outside this session's own
      // workspace. A stale carryover from an earlier session in a different
      // directory would otherwise render a FOREIGN workflow onto the canvas
      // (observed: a session in one workspace showing a workflow from
      // ~/harness-playground). Cleared here, the session simply starts unbound
      // and its own workspace scan re-binds a local workflow.
      if (session.boundWorkflowPath) {
        const root = resolve(session.cwd);
        const target = resolve(session.boundWorkflowPath);
        if (target !== root && !target.startsWith(root + sep)) {
          session.boundWorkflowPath = null;
          dirty = true;
        }
      }
      this.sessions.set(session.id, session);
    }
    dirty = (await this.loadAgentSessionOwners(persisted)) || dirty;
    await this.loadSubsessionBindings();
    if (dirty) await this.persist();
  }

  list(): HarnessSession[] {
    return Array.from(this.sessions.values());
  }

  get(id: string): HarnessSession | undefined {
    return this.sessions.get(id);
  }

  /** True only when this process owns the live PTY behind the record. */
  isLive(id: string): boolean {
    return this.ptys.has(id);
  }

  private getAdapter(harness: HarnessKind): HarnessAdapter {
    const adapter = this.adapters[harness];
    if (!adapter) {
      // Before surfacing a generic "adapter not found", check whether this id
      // belongs to a known external-mode adapter — if so, the 409 with a human
      // message ("X sessions are managed by the X app") is far more actionable
      // than "no adapter registered for harness X".  A sessions.json entry
      // with harness="conductor" (written by an earlier build, hand-edited, or
      // a future registration) hits this path on resume/submitInput.
      const info = listHarnessAdapters().find((a) => a.id === harness);
      if (info?.mode === "external") throw new ExternalHarnessError(harness, info.label);
      throw new AdapterNotFoundError(harness);
    }
    return adapter;
  }

  /** Recheck the immutable project principal immediately before spawning. */
  private async revalidateAgentMapIdentity(
    sessionId: string,
    cwd: string,
    expected: ProjectAgentSession | undefined,
  ): Promise<void> {
    if (!expected || !this.resolveAgentMapIdentity) return;
    const current = await this.resolveAgentMapIdentity(
      sessionId,
      cwd,
      expected,
    );
    if (!current || !sameProjectAgent(current, expected)) {
      throw new ProjectSessionScopeUnavailableError(sessionId);
    }
  }

  async create(
    req: CreateSessionRequest,
    trusted: TrustedSessionCreateOptions = {},
  ): Promise<HarnessSession> {
    return this.createWithId(this.generateId(), req, trusted);
  }

  /**
   * Registers a purely historical (never-launched-by-this-harness) session so
   * it can subsequently be resumed via `resume()`. Called by
   * `POST /api/sessions/adopt` when a user opens a transcript-only history row
   * whose transcript the agent genuinely still holds — that row then resumes
   * for real instead of silently starting a fresh session in the directory,
   * which is what happened for as long as nothing called this.
   *
   * The record is born `exited` with `createdAt === lastActiveAt` (nothing has
   * run under our management yet). `resume()` is what gives it a pty, and the
   * adopt route pre-verifies resumability before registering, so this never
   * mints a record that can't be resumed.
   */
  async registerHistorical(input: {
    agentSessionId: string;
    harness: HarnessKind;
    cwd: string;
    title: string;
    lastActiveAt: string;
  }): Promise<HarnessSession> {
    const id = this.generateId();
    return this.serializeAgentSessionIdentity(async () => {
      const digest = this.agentSessionIdentityDigest(input.agentSessionId);
      const existingOwnerId = this.agentSessionOwners.get(digest);
      if (existingOwnerId) {
        const existing = this.sessions.get(existingOwnerId);
        if (existing?.agentSessionId === input.agentSessionId) return existing;
        throw new AgentSessionIdentityReservedError();
      }
      const session: HarnessSession = {
        id,
        agentSessionId: input.agentSessionId,
        harness: input.harness,
        cwd: input.cwd,
        title: input.title,
        status: "exited",
        createdAt: input.lastActiveAt,
        lastActiveAt: input.lastActiveAt,
        exitCode: null,
        boundWorkflowPath: null,
        ready: false,
      };
      await this.reserveAgentSessionIdentity(digest, id);
      let releaseFence: () => void = () => {};
      const fence = new Promise<void>((resolveFence) => {
        releaseFence = resolveFence;
      });
      this.sessionRegistryIdentityFence = fence;
      try {
        await this.persistIdentityCandidate(session);
        this.sessions.set(id, session);
      } finally {
        this.sessionRegistryIdentityFence = null;
        releaseFence();
      }
      return session;
    });
  }

  async resume(
    id: string,
    trusted: TrustedSessionResumeOptions = {},
  ): Promise<HarnessSession> {
    if (this.closing) throw new SessionManagerClosingError();
    const session = this.sessions.get(id);
    if (!session) throw new UnknownSessionError(id);
    if (!session.agentSessionId) {
      throw new SessionNotResumeableError(id);
    }
    if (this.ptys.has(id)) {
      throw new SessionAlreadyLiveError(id);
    }
    if (this.rejectedProjectSessionMetadata.has(id)) {
      throw new ProjectSessionScopeUnavailableError(id);
    }
    const bindingTransition = trusted.subsessionBindingTransition;
    if (bindingTransition) {
      const expected = parseTrustedSubsessionBindingMarker(
        bindingTransition.expected,
        id,
      );
      const next = parseTrustedSubsessionBindingMarker(
        bindingTransition.next,
        id,
      );
      const current = this.subsessionBindings.get(id);
      if (
        !expected ||
        !next ||
        !current ||
        (!sameSubsessionBinding(current, expected) &&
          !sameSubsessionBinding(current, next)) ||
        next.projectId !== expected.projectId ||
        next.parentSessionId !== expected.parentSessionId ||
        next.bindingId !== expected.bindingId ||
        next.sessionId !== expected.sessionId ||
        next.incarnation !== expected.incarnation + 1 ||
        next.spawnEpoch <= expected.spawnEpoch ||
        this.userClosedSubsessions.has(id)
      ) {
        throw new SubsessionBindingMismatchError();
      }
    }
    const adapter = this.getAdapter(session.harness);
    // Pre-flight against the agent's OWN store before touching the record.
    // Holding an agentSessionId only means our SessionStart hook fired once;
    // an agent that never received a prompt writes no transcript, so
    // `--resume` would exit 1 with "No conversation found with session ID"
    // and leave the user on a dead pane offering Resume all over again.
    // Failing here instead keeps the record exactly as it was — unspawned,
    // and (see below) with its real lastActiveAt intact.
    if (!(await adapter.canResume(session.agentSessionId, session.cwd))) {
      const label =
        listHarnessAdapters().find((a) => a.id === session.harness)?.label ??
        session.harness;
      throw new SessionNotResumeableError(
        id,
        `${label} no longer has the conversation for this session (${session.agentSessionId}) in ${session.cwd}. ` +
          `Sessions that ended before their first prompt are never written to the coding agent's history, so there is nothing to resume — start a new session in this directory instead.`,
      );
    }
    if (bindingTransition) {
      const current = this.subsessionBindings.get(id)!;
      // A failed spawn may leave the exact next marker durably committed.
      // Retrying that same transition must not require the old marker again.
      if (!sameSubsessionBinding(current, bindingTransition.next)) {
        this.subsessionBindings.set(id, bindingTransition.next);
        try {
          await this.persistSubsessionBindings();
        } catch (error) {
          this.subsessionBindings.set(id, current);
          throw error;
        }
      }
    }
    const trustedIdentity = session.agentMapIdentity;
    const agentMapIdentity = this.resolveAgentMapIdentity
      ? await this.resolveAgentMapIdentity(id, session.cwd, trustedIdentity)
      : trustedIdentity;
    if (agentMapIdentity)
      session.agentMapIdentity = structuredClone(agentMapIdentity);
    else if (trustedIdentity) throw new ProjectSessionScopeUnavailableError(id);
    if (trusted.focusedContext && !agentMapIdentity)
      throw new TypeError("Focused project context requires a project-agent identity");
    // Claim the pre-PTY resume window before generated launch state is built.
    // Exit observers may finish asynchronous bookkeeping after kill() resolves;
    // they must see this lifecycle as starting, not schedule cleanup against
    // files that the resumed process is currently regenerating.
    const lastActiveBeforeResume = session.lastActiveAt;
    const statusBeforeResume = session.status;
    const exitCodeBeforeResume = session.exitCode;
    session.status = "starting";
    session.exitCode = null;
    session.lastActiveAt = this.now();
    let opts: LaunchOpts;
    let spec: SpawnSpec;
    try {
      const launchContext =
        trusted.promptAppendix || trusted.focusedContext || agentMapIdentity
          ? {
              ...(trusted.promptAppendix
                ? { promptAppendix: trusted.promptAppendix }
                : {}),
              ...(trusted.focusedContext
                ? { focusedContext: trusted.focusedContext }
                : {}),
              ...(agentMapIdentity ? { agentMapIdentity } : {}),
              resume: true as const,
            }
          : undefined;
      opts = {
        harnessSessionId: id,
        cwd: session.cwd,
        ...(await (launchContext
          ? this.buildLaunchOpts(id, session, launchContext)
          : this.buildLaunchOpts(id, session))),
      };
      spec = adapter.resume(session.agentSessionId, opts);
    } catch (error) {
      // Resume preparation may rotate project capabilities or write generated
      // launch state before the process exists. No starting state was exposed
      // or persisted yet, so restore the exact prior record while releasing
      // any prepared authority.
      session.status = statusBeforeResume;
      session.exitCode = exitCodeBeforeResume;
      session.lastActiveAt = lastActiveBeforeResume;
      await Promise.resolve(this.onAgentMapSessionExit?.(id)).catch(() => {});
      throw error;
    }
    // The prior value is kept so the failure path below can put it back:
    // `lastActiveAt` is stamped only to keep sweepDeadSessions() from reaping
    // this record
    // during the pre-pty window (it reaps non-exited records with no pty once
    // they're older than the grace period). If the resume never produces a
    // pty, that stamp is not activity and must not survive — otherwise a
    // session idle since last night reports "Ran for 6h 25m" purely because
    // someone clicked Resume.
    try {
      await this.persist();
      this.emitStatus(session);
      // Schema-aware and strict: the caller leaves a valid current file
      // untouched, translates a valid legacy file, and reconstructs anything
      // missing/invalid from this session plus the live registry. Await it in
      // the prompt-regeneration window so no resumed process can observe the
      // new prompt with an old context contract.
      await this.prepareWorkspaceContext(session);
      // Also backfill-only (ensureCanvasTemplate does its own existence check)
      // — a session from before the canvas kit existed, or one whose canvas
      // file was somehow deleted, still gets a live pane on resume.
      await this.ensureCanvasTemplate(session.cwd);
      await this.spawn(session, spec, () =>
        this.revalidateAgentMapIdentity(
          session.id,
          session.cwd,
          agentMapIdentity,
        ),
      );
      if (session.projectBootstrap) {
        const runtimeEpoch = this.getRuntimeEpoch(session.id);
        if (runtimeEpoch === null) throw new Error("session runtime unavailable");
        await Promise.resolve(
          this.onProjectBootstrapSession?.(session, "resumed", runtimeEpoch),
        ).catch(() => {});
      }
    } catch (err) {
      // Same best-effort reconciliation as create(): the first persist can be
      // the failure, and a failed repair must not replace that original error.
      // Roll the pre-pty `lastActiveAt` stamp back at the same time: no pty
      // ever ran, so the session's last real activity is still where it was,
      // and the dead pane's "Ran for" stays truthful.
      session.lastActiveAt = lastActiveBeforeResume;
      await this.transitionExited(session, null, {
        stampLastActive: false,
      }).catch(() => {});
      throw err;
    }
    return session;
  }

  /** Server-only same-ID resume fenced by the coordinator's private marker. */
  resumeBound(
    id: string,
    expected: TrustedSubsessionBindingMarker,
    next: TrustedSubsessionBindingMarker,
    trusted: Omit<TrustedSessionResumeOptions, "subsessionBindingTransition"> = {},
  ): Promise<HarnessSession> {
    return this.resume(id, {
      ...trusted,
      subsessionBindingTransition: { expected, next },
    });
  }

  /**
   * Close the session and durably record a user-closed delegated binding.
   * Termination starts before storage writes, so a persistence failure cannot
   * leave its PTY running. Failed closure bookkeeping retains a tombstone that
   * prevents automatic recovery and can be retried by a later close.
   *
   * Await this operation and handle rejection: binding persistence and the
   * coordinator callback can fail, and their completion has no time bound.
   * On success, returns kill()'s result: whether a live or stale session was
   * transitioned to exited.
   */
  async close(id: string): Promise<boolean> {
    const binding = this.subsessionBindings.get(id);
    if (binding) {
      this.userClosedSubsessions.add(id);
    }
    // Start termination before persistence so a sidecar fsync failure cannot
    // leave a delegated PTY running after the user closes its tab. Keep the
    // in-memory tombstone on failure and let a later close retry persistence.
    const termination = this.kill(id);
    let persistenceError: unknown;
    let coordinatorCloseRecorded = false;
    if (binding) {
      try {
        await this.persistSubsessionBindings();
      } catch (error) {
        persistenceError = error;
      }
      try {
        if (this.onSubsessionUserClosed) {
          await this.onSubsessionUserClosed(binding);
          coordinatorCloseRecorded = true;
        }
      } catch (error) {
        persistenceError ??= error;
      }
    }
    const killed = await termination;
    if (binding && persistenceError === undefined && coordinatorCloseRecorded) {
      const current = this.subsessionBindings.get(id);
      if (current && sameSubsessionBinding(current, binding)) {
        this.subsessionBindings.delete(id);
        this.userClosedSubsessions.delete(id);
        try {
          await this.persistSubsessionBindings();
        } catch (error) {
          this.subsessionBindings.set(id, binding);
          this.userClosedSubsessions.add(id);
          persistenceError = error;
        }
      }
    }
    if (persistenceError !== undefined) throw persistenceError;
    return killed;
  }

  /** Close only when the caller proves the exact coordinator-owned binding. */
  async closeBound(expected: TrustedSubsessionBindingMarker): Promise<boolean> {
    const parsed = parseTrustedSubsessionBindingMarker(
      expected,
      expected.sessionId,
    );
    if (!parsed) throw new SubsessionBindingMismatchError();
    const operation = async (): Promise<boolean> => {
      const current = this.subsessionBindings.get(parsed.sessionId);
      if (!current || !sameSubsessionBinding(current, parsed))
        throw new SubsessionBindingMismatchError();
      return this.close(parsed.sessionId);
    };
    const next = this.subsessionBindingQueue.catch(() => {}).then(operation);
    this.subsessionBindingQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Signals the session's pty to exit and returns a Promise that resolves
   * once the process is **actually gone** — not fire-and-forget.
   *
   * Resolution source (either one unblocks the promise):
   *   1. node-pty's own `onExit` event → markExited() → `handle.exited` resolves.
   *   2. Synthesized exit: kill()'s escalation fallback (SIGTERM → SIGKILL →
   *      pid liveness check) → markExited() → `handle.exited` resolves.
   *   3. Synthesized exit from an external `sweepDeadSessions()` call that
   *      happens to run during the escalation window → same path.
   *
   * The promise is bounded: after `KILL_ESCALATION_MS` the escalation sends
   * SIGKILL; after a further `KILL_ESCALATION_CONFIRM_MS` it synthesizes the
   * exit from an OS-level pid check regardless of node-pty's event. So the
   * worst-case resolution time is `KILL_ESCALATION_MS + KILL_ESCALATION_CONFIRM_MS`
   * (2500 ms at current constants), never infinite.
   *
   * Existing fire-and-forget callers keep working: an unawaited Promise is
   * fine and produces no floating-promise lint warnings when suppressed with
   * `void`.
   *
   * Returns false (resolved immediately) when the session has no live pty.
   * Returns true (resolved on actual death) when a pty was signalled.
   */
  kill(id: string): Promise<boolean> {
    const handle = this.ptys.get(id);
    if (!handle) {
      // A non-exited record with no pty behind it has nothing left to kill —
      // it's a ghost (its pty died without the exit ever being recorded).
      // Reconcile it here so closing the tab actually closes it, instead of
      // returning false and leaving an unclosable non-exited record.
      const session = this.sessions.get(id);
      if (session && session.status !== "exited") {
        void this.transitionExited(session, null);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    }
    // Mark before signalling so markExited() (whichever path reports the death)
    // knows this exit was intentional and skips the exit-tail capture.
    handle.killed = true;
    handle.pty.kill();
    // Root-caused via instrumented real-process runs: node-pty's `onExit`
    // can simply never fire for a pty killed within milliseconds of being
    // spawned — confirmed by `process.kill(pid, 0)` throwing ESRCH (no such
    // process) well after the graceful signal, i.e. the OS process really
    // is already gone; node-pty's own exit-reporting just missed it. So a
    // stronger signal alone doesn't help (there's nothing left to signal) —
    // the fallback below re-checks after a grace period, and if the pty is
    // still "running" in our registry but the OS confirms the process no
    // longer exists, synthesizes the exit ourselves rather than waiting on
    // an event that isn't coming. If the process genuinely is still alive
    // (the ordinary case: kill() just hasn't taken effect yet), send SIGKILL
    // as a real escalation before the same check.
    const escalate = setTimeout(() => {
      if (this.ptys.get(id) !== handle) return;
      const pid = handle.pty.pid;
      if (this.isPidAlive(pid)) handle.pty.kill("SIGKILL");
      setTimeout(() => {
        // Synthesize unconditionally: SIGKILL was already sent; after the
        // confirm window the session is over regardless of isPidAlive. An
        // EPERM-alive zombie (a process that exists but can't be signalled)
        // would leave handle.exited pending forever if we gated on liveness.
        if (this.ptys.get(id) === handle) this.markExited(id, handle, null);
      }, KILL_ESCALATION_CONFIRM_MS).unref?.();
    }, KILL_ESCALATION_MS);
    escalate.unref?.();
    // Return a promise that resolves on actual death — either the real onExit
    // event or a synthesized exit from the escalation above or sweepDeadSessions.
    // `handle.exited` is resolved by markExited(), which is the single
    // convergence point for all three paths — it never hangs.
    return handle.exited.then(() => true);
  }

  /**
   * Kills every currently-live pty and returns a Promise that resolves when
   * all of them have actually exited (real or synthesized). Bounded by the
   * same escalation window as `kill()` — never hangs.
   *
   * Call this on server shutdown so the process actually exits instead of
   * waiting on orphaned claude/codex children. A bounded timeout can be layered
   * on top via `Promise.race` when callers need a hard deadline:
   *   `await Promise.race([sessionManager.killAll(), sleep(5_000)])`
   */
  async killAll(): Promise<void> {
    const kills = [...this.ptys.keys()].map((id) => this.kill(id));
    await Promise.all(kills);
  }

  /**
   * Defensive liveness backstop, run periodically by the server: any
   * non-exited session whose pty process is provably gone gets its exit
   * synthesized. The specific transitions are already reconciled at their
   * source (create/resume pre-pty failures, kill()'s missed-exit fallback),
   * but node-pty has been observed to simply never fire `onExit` for a
   * process that died moments after spawning (see `kill()`) — and a process
   * that dies *on its own* that way has no kill()-style fallback watching
   * it. This sweep is the catch-all for that and any transition not yet
   * root-caused: a stale record shows as a ghost tab (non-exited status, no
   * live pty) until something reconciles it.
   */
  sweepDeadSessions(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.status === "exited") continue;
      const handle = this.ptys.get(session.id);
      if (handle) {
        // Guard against non-numeric pids (test fakes) — never probe the OS
        // with a garbage value, and never declare a session dead on one.
        if (typeof handle.pty.pid === "number" && !this.isPidAlive(handle.pty.pid)) {
          this.markExited(session.id, handle, null);
        }
        continue;
      }
      // No pty handle at all. Within create()/resume() there's a legitimate
      // pre-spawn window where the persisted record briefly looks like this,
      // so only sweep records older than the grace period (an unparseable
      // lastActiveAt is garbage and sweeps immediately).
      const ageMs = Date.now() - Date.parse(session.lastActiveAt);
      if (!(ageMs < NO_PTY_SWEEP_GRACE_MS)) void this.transitionExited(session, null);
    }
  }

  /**
   * Forward terminal bytes without submitting a separate prompt.
   * @throws SessionInputIsolationError when prior partial input cannot be cleared.
   */
  write(id: string, data: string): boolean {
    const handle = this.ptys.get(id);
    if (!handle) return false;
    if (!this.resetUnsafeComposer(handle)) {
      throw new SessionInputIsolationError();
    }
    const session = this.sessions.get(id);
    if (session && session.status !== "exited") {
      try {
        const adapter = this.adapters[session.harness];
        const blockingPrompt = Boolean(
          adapter?.detectBlockingPrompt &&
          (this.hasCurrentBlockingPrompt(adapter, handle) ||
            this.hasRetainedBlockingPrompt(adapter, handle)),
        );
        this.onTerminalInput(id, {
          runtimeEpoch: handle.runtimeEpoch,
          blockingPrompt,
        });
      } catch {
        // Input priority is local correctness; lifecycle telemetry/persistence
        // callbacks are best effort and cannot block a person's terminal.
      }
    }
    this.terminalInputEpochs.set(
      id,
      (this.terminalInputEpochs.get(id) ?? 0) + 1,
    );
    const staged = this.stagedInputs.get(id);
    if (staged?.handle === handle && !staged.preempted) {
      staged.preempted = true;
      if (staged.textWritten) {
        // Remove the server-staged line before forwarding the person's bytes,
        // so the two inputs can never be submitted as one corrupted prompt.
        if (!this.abandonStagedLine(handle)) {
          throw new SessionInputIsolationError();
        }
        staged.lineCleared = true;
      }
    }
    try {
      handle.pty.write(data);
    } catch (error) {
      // Raw terminal data can also be reported failed after staging a prefix.
      // Fence the exact handle before any later user or server-owned write;
      // bracketed-paste input requires its closing marker during recovery.
      this.markComposerUnsafe(handle, data.includes(BRACKETED_PASTE_START));
      throw error;
    }
    this.observeTrustedTerminalInput(handle, data);
    if (session) {
      session.lastActiveAt = this.now();
      void this.persist();
    }
    return true;
  }

  /**
   * Inject a discrete prompt (macros, the Visualize button, `/api/sessions/:id/input`)
   * with proper submit semantics — distinct from `write()`, which is a raw
   * passthrough for live keystrokes from the terminal WS and must never add
   * this delay/splitting behavior. See `SUBMIT_DELAY_MS` for why non-empty
   * submitted text can't just be written as `${text}\r` in one call.
   *
   * Gated on readiness (see `HarnessSession.ready` / `isReadyEnough`): a
   * "running" pty can still be sitting on a blocking prompt that swallows
   * whatever's written to it. Briefly waits out `READY_GRACE_MS` for the
   * ordinary "fired a beat too early" case; throws `SessionNotReadyError`
   * — never silently proceeds — if the session still isn't ready after
   * that, so the caller (rest.ts, macros.ts) can surface a clear reason
   * instead of the input just vanishing.
   */
  async submitInput(
    id: string,
    text: string,
    submit = true,
    canWrite?: () => boolean | Promise<boolean>,
    background = false,
    lifecycle?: SessionInputWriteLifecycle,
  ): Promise<boolean> {
    const remainsAuthorized = async (): Promise<boolean> => {
      if (!canWrite) return true;
      try {
        return await canWrite();
      } catch {
        return false;
      }
    };
    const session = this.sessions.get(id);
    if (!session) return false;
    const initialTerminalInputEpoch = this.terminalInputEpochs.get(id) ?? 0;

    // An external-harness session (e.g. conductor) never has a pty — surfacing
    // HARNESS_EXTERNAL here gives a 409 "managed by the X app" instead of a
    // misleading 404 "session not found or has no live pty".
    const handle = this.ptys.get(id);
    if (!handle) {
      const info = listHarnessAdapters().find((a) => a.id === session.harness);
      if (info?.mode === "external")
        throw new ExternalHarnessError(session.harness, info.label);
      return false;
    }
    if (!this.isReadyEnough(session, handle)) {
      const becameReady = await this.waitUntilReady(id, READY_GRACE_MS);
      if (!becameReady) throw new SessionNotReadyError(id);
      // waitUntilReady only confirms readiness, not that the same pty is
      // still the live one — re-fetch in case it was killed/replaced (e.g.
      // a resume) while we were waiting, same as the mid-write race below.
      if (this.ptys.get(id) !== handle) return false;
    }
    // Re-evaluate after any readiness wait, immediately before the first byte
    // crosses into the PTY. Planner callers use this to close project/account
    // rebinding races; ordinary session inputs do not pass a guard.
    if (canWrite && !(await remainsAuthorized())) {
      throw new SessionInputGuardRejectedError(false);
    }
    if (
      background &&
      (this.terminalInputEpochs.get(id) ?? 0) !== initialTerminalInputEpoch
    ) {
      throw new SessionBackgroundInputPreemptedError(false);
    }
    if (!this.resetUnsafeComposer(handle)) {
      // No byte from this logical submission has been written, but the prior
      // unknown composer cannot yet be declared clean. Let durable callers
      // keep their request queued; never append it to residual text.
      await lifecycle?.onNotSubmitted?.().catch(() => {});
      throw new SessionInputIsolationError();
    }
    if (lifecycle?.beforeFirstWrite) {
      try {
        await lifecycle.beforeFirstWrite();
      } catch (error) {
        await lifecycle.onNotSubmitted?.().catch(() => {});
        throw error;
      }
    }
    if (
      background &&
      (this.terminalInputEpochs.get(id) ?? 0) !== initialTerminalInputEpoch
    ) {
      // The durable claim may yield while a person types into this composer.
      // Retire that claim without appending background text or pressing Enter.
      await lifecycle?.onNotSubmitted?.().catch(() => {});
      throw new SessionBackgroundInputPreemptedError(false);
    }
    if (this.closing || (lifecycle?.canWriteNow && !lifecycle.canWriteNow())) {
      await lifecycle?.onNotSubmitted?.().catch(() => {});
      throw new SessionInputGuardRejectedError(false);
    }

    if (!submit) {
      try {
        lifecycle?.onWritePhase?.("text-staged");
        handle.pty.write(text);
      } catch (error) {
        // submit:false is public arbitrary draft text, not a single control
        // byte. A partial failure can therefore leave composer content even
        // though no Enter was requested.
        this.markComposerUnsafe(handle, false);
        throw error;
      }
      this.observeTrustedSubmittedText(handle, text);
    } else if (text.length === 0) {
      try {
        lifecycle?.onWritePhase?.("text-staged");
        handle.pty.write("\r");
        lifecycle?.onWritePhase?.("enter-written");
      } catch (error) {
        // Enter may have crossed or may have left an existing draft intact.
        // Either way, require a proven reset before another submission.
        this.markComposerUnsafe(handle, false);
        throw error;
      }
      this.observeTrustedTerminalInput(handle, "\r");
    } else {
      // Bracketed when the app supports it: newlines in the prompt (the canvas
      // chat prepends a multi-line step context to every question) then stay
      // literal instead of each submitting a fragment, and the `\r` below is
      // read as Enter rather than as more pasted content.
      //
      // Observation wins when we have one; the adapter's declared assumption
      // only covers the never-observed case — under ConPTY the app's
      // `ESC[?2004h` announcement is re-rendered away, so on Windows a Claude
      // session that DOES accept bracketed paste looked like one that doesn't
      // and multi-line prompts submitted at their first newline.
      // win32 only: the blind spot is ConPTY's (it re-renders output instead
      // of passing DEC private-mode sequences through). On POSIX a real 2004
      // announcement always arrives, so "not observed yet" there means the
      // app genuinely hasn't enabled it — and writing paste markers at such
      // an app renders them as literal text, the behaviour the observation
      // channel exists to avoid.
      const paste = handle.bracketedPaste.observed
        ? handle.bracketedPaste.enabled
        : this.platform === "win32" &&
          (this.adapters[session.harness]?.assumesBracketedPaste ?? false);
      const staged = {
        handle,
        background,
        preempted: false,
        textWritten: false,
        lineCleared: false,
      };
      if (this.stagedInputs.has(id)) {
        await lifecycle?.onNotSubmitted?.().catch(() => {});
        throw new SessionBackgroundInputPreemptedError(false);
      }
      this.stagedInputs.set(id, staged);
      let enterAttempted = false;
      try {
        try {
          lifecycle?.onWritePhase?.("text-staged");
          handle.pty.write(paste ? wrapPaste(text) : text);
        } catch (error) {
          // A PTY can report a text-write failure after staging a prefix. Clear
          // that possible partial line before claiming the logical submission
          // is safe to retry. A partial bracketed paste can leave the terminal
          // inside paste mode, where Ctrl-U is merely pasted content, so close
          // that mode first. Every required cleanup write must succeed before
          // exposing positive not-submitted evidence.
          let pasteClosed = !paste;
          try {
            if (paste) {
              handle.pty.write(BRACKETED_PASTE_END);
              this.observeTrustedTerminalInput(handle, BRACKETED_PASTE_END);
              pasteClosed = true;
            }
          } catch {
            // Still attempt a non-submitting line clear below, but do not call
            // it proof when the terminal may remain in bracketed-paste mode.
          }
          try {
            handle.pty.write("\x15");
            this.observeTrustedTerminalInput(handle, "\x15");
            staged.lineCleared = pasteClosed;
          } catch {
            // The coordinator retains its dispatch intent and fails closed.
          }
          if (!staged.lineCleared) {
            this.markComposerUnsafe(handle, !pasteClosed);
          }
          throw error;
        }
        staged.textWritten = true;
        // Observe the server-owned plaintext rather than the bracketed-paste
        // transport wrapper. Embedded newlines invalidate the line, so prompt
        // text containing `/clear` cannot impersonate an exact slash command.
        this.observeTrustedSubmittedText(handle, text);
        await sleep(SUBMIT_DELAY_MS);
        if (staged.preempted) {
          throw new SessionBackgroundInputPreemptedError(true);
        }
        // The pty may have been killed/replaced while we were waiting.
        if (this.ptys.get(id) !== handle) return false;
        // A project/account can change during the deliberate text→Enter delay.
        // Do not submit the staged text under stale authority.
        if (canWrite && !(await remainsAuthorized())) {
          // Text was staged but not submitted. Clear the composer before
          // releasing control so a later keypress cannot submit project-scoped
          // content into the now-stale session. Ctrl-U is a local line-clear,
          // not an Enter/submission gesture.
          staged.lineCleared = this.abandonStagedLine(handle);
          throw new SessionInputGuardRejectedError(true);
        }
        // `await remainsAuthorized()` necessarily yields. Shutdown or a
        // coordinator generation change can win in that gap, so this final
        // synchronous fence is the last operation before Enter.
        if (
          this.closing ||
          (lifecycle?.canWriteNow && !lifecycle.canWriteNow())
        ) {
          staged.lineCleared = this.abandonStagedLine(handle);
          throw new SessionInputGuardRejectedError(true);
        }
        enterAttempted = true;
        handle.pty.write("\r");
        lifecycle?.onWritePhase?.("enter-written");
        this.observeTrustedTerminalInput(handle, "\r");
      } catch (error) {
        if (enterAttempted) {
          // A failed Enter write is ambiguous: it may have submitted A or may
          // have left A's full staged line in place. Fence the handle so B can
          // never append until a non-submitting reset succeeds.
          this.markComposerUnsafe(handle, false);
        } else if (staged.lineCleared) {
          await lifecycle?.onNotSubmitted?.().catch(() => {});
        }
        throw error;
      } finally {
        if (this.stagedInputs.get(id) === staged) {
          this.stagedInputs.delete(id);
        }
      }
    }

    session.lastActiveAt = this.now();
    void this.persist();
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const handle = this.ptys.get(id);
    if (!handle) return false;
    handle.pty.resize(cols, rows);
    return true;
  }

  /**
   * Subscribe to a session's output. Replays the retained scrollback buffer
   * synchronously before returning so a reconnecting WS client sees recent
   * output immediately. Returns undefined if the session has no live pty.
   */
  attach(id: string, listener: SessionDataListener): (() => void) | undefined {
    const handle = this.ptys.get(id);
    if (!handle) return undefined;
    if (handle.buffer) listener(handle.buffer);
    handle.emitter.on("data", listener);
    return () => handle.emitter.off("data", listener);
  }

  onStatusChange(listener: SessionStatusListener): () => void {
    this.statusEmitter.on("status", listener);
    return () => {
      this.statusEmitter.off("status", listener);
    };
  }

  /**
   * Subscribe to a session producing terminal output — throttled (see
   * `ACTIVITY_BROADCAST_THROTTLE_MS`), not one event per pty.onData chunk.
   * Fires for every session regardless of whether anything has its
   * /ws/terminal socket open, unlike `attach()`.
   */
  onActivity(listener: SessionActivityListener): () => void {
    this.activityEmitter.on("activity", listener);
    return () => {
      this.activityEmitter.off("activity", listener);
    };
  }

  /**
   * Leading-edge throttle: broadcasts immediately on the first byte after a
   * quiet period, then drops everything else for this session until
   * `ACTIVITY_BROADCAST_THROTTLE_MS` has elapsed — a busy TUI's onData fires
   * far more often than that, and callers (the SPA's per-tab pulse) only
   * care that the session is active right now, not each individual chunk.
   */
  private recordActivity(id: string): void {
    const now = Date.now();
    const last = this.lastActivityBroadcast.get(id) ?? 0;
    if (now - last < ACTIVITY_BROADCAST_THROTTLE_MS) return;
    this.lastActivityBroadcast.set(id, now);
    this.activityEmitter.emit("activity", id);
  }

  /**
   * Maintain a readiness-only view of terminal output. Codex's Ratatui loop
   * emits a ~500-byte cursor/erase repaint every 80ms even when the visible
   * screen is unchanged. Counting those chunks as startup progress both
   * prevents the 700ms settle window from ever completing and pushes a real
   * sign-in/trust prompt out of the raw 4KB tail. Synchronized-output markers
   * give us an atomic repaint boundary: retain the latest repaint containing
   * visible text, keep a bounded union for diff-rendered blocking prompts,
   * and ignore control-only frames. Non-Ratatui adapters fall back to an
   * ordinary rolling buffer.
   */
  private recordReadinessOutput(
    handle: PtyHandle,
    chunk: string,
    adapter: HarnessAdapter,
  ): void {
    let rest = handle.pendingReadinessPrefix + chunk;
    handle.pendingReadinessPrefix = "";
    while (rest.length > 0) {
      if (handle.pendingReadinessFrame !== null) {
        // Search the combined stream so an end marker split across two
        // node-pty chunks still closes the repaint.
        const combined = handle.pendingReadinessFrame + rest;
        const end = combined.indexOf(SYNC_OUTPUT_END);
        if (end === -1) {
          handle.pendingReadinessFrame = combined.slice(-SCROLLBACK_BYTES);
          if (
            !handle.pendingReadinessFrameHasContent &&
            this.hasVisibleReadinessContent(handle.pendingReadinessFrame)
          ) {
            handle.pendingReadinessFrameHasContent = true;
            this.noteReadinessContent(handle);
          }
          return;
        }
        const throughEnd = end + SYNC_OUTPUT_END.length;
        const frame = combined.slice(0, throughEnd);
        handle.pendingReadinessFrame = null;
        handle.pendingReadinessFrameHasContent = false;
        this.commitReadinessOutput(handle, frame, true, adapter);
        rest = combined.slice(throughEnd);
        continue;
      }

      const start = rest.indexOf(SYNC_OUTPUT_START);
      if (start === -1) {
        // Retain only a suffix that could become a start marker when the next
        // chunk arrives. Everything before it is ordinary unsynchronized
        // output and can be committed now.
        let prefixLength = Math.min(SYNC_OUTPUT_START.length - 1, rest.length);
        while (prefixLength > 0 && !SYNC_OUTPUT_START.startsWith(rest.slice(-prefixLength))) {
          prefixLength -= 1;
        }
        const outputEnd = rest.length - prefixLength;
        this.commitReadinessOutput(
          handle,
          rest.slice(0, outputEnd),
          false,
          adapter,
        );
        handle.pendingReadinessPrefix = rest.slice(outputEnd);
        return;
      }
      this.commitReadinessOutput(handle, rest.slice(0, start), false, adapter);
      handle.pendingReadinessFrame = SYNC_OUTPUT_START;
      handle.pendingReadinessFrameHasContent = false;
      rest = rest.slice(start + SYNC_OUTPUT_START.length);
    }
  }

  private hasVisibleReadinessContent(output: string): boolean {
    // stripAnsi intentionally targets common display escapes and leaves a few
    // private CSI controls (for example ESC[>4;0m). Remove those first so a
    // protocol negotiation cannot count as visible TUI content.
    /* eslint-disable no-control-regex -- readiness parsing must match literal
     * ESC/BEL control bytes emitted by the pty. */
    const rendered = stripAnsi(
      output.replace(/\x1b\[[?>][0-9;]*[ -/]*[@-~]/g, ""),
    )
      // An atomic repaint can be split in the middle of a CSI/OSC sequence.
      // Do not treat the printable parameter bytes in that unfinished suffix
      // as visible content before the next pty chunk completes it.
      .replace(/\x1b\[[0-?]*[ -/]*$/u, "")
      .replace(/\x1b\][^\x07]*$/u, "")
      .replace(/\x1b[()>=]?$/u, "");
    const hasVisibleContent = /[^\s\x00-\x1f\x7f]/u.test(rendered);
    /* eslint-enable no-control-regex */
    return hasVisibleContent;
  }

  private noteReadinessContent(handle: PtyHandle): void {
    const now = Date.now();
    handle.readinessCandidateAt ??= now;
    handle.lastOutputAt = now;
  }

  private commitReadinessOutput(
    handle: PtyHandle,
    output: string,
    replace: boolean,
    adapter: HarnessAdapter,
  ): void {
    if (!this.hasVisibleReadinessContent(output)) return;
    this.noteReadinessContent(handle);
    handle.readinessBuffer = (
      replace ? output : handle.readinessBuffer + output
    ).slice(-SCROLLBACK_BYTES);
    handle.readinessHistory = `${handle.readinessHistory}\n${output}`.slice(
      -BLOCKING_PROMPT_SCAN_BYTES,
    );
    this.refreshImmediatePromptState(adapter, handle);
  }

  setAgentSessionId(
    id: string,
    agentSessionId: string,
    source?: unknown,
    runtimeEpoch?: string,
  ): Promise<boolean> {
    return this.serializeAgentSessionIdentity(() =>
      this.setAgentSessionIdLocked(id, agentSessionId, source, runtimeEpoch),
    );
  }

  /** Resolve a current or historical vendor-id tombstone without disclosing
   * the raw alias anywhere outside this server process. Used by the generic
   * adopt route to preserve the scoped planner boundary after a rotation. */
  getAgentSessionOwner(agentSessionId: string): HarnessSession | undefined {
    const ownerId = this.agentSessionOwners.get(
      this.agentSessionIdentityDigest(agentSessionId),
    );
    return ownerId ? this.sessions.get(ownerId) : undefined;
  }

  /** Whether the private ledger retains this current or historical alias,
   * including a fail-closed tombstone whose original registry row is absent. */
  isAgentSessionIdentityReserved(agentSessionId: string): boolean {
    return this.agentSessionOwners.has(
      this.agentSessionIdentityDigest(agentSessionId),
    );
  }

  private async setAgentSessionIdLocked(
    id: string,
    agentSessionId: string,
    source?: unknown,
    runtimeEpoch?: string,
  ): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    const handle = this.ptys.get(id);
    if (runtimeEpoch !== undefined && handle?.runtimeEpoch !== runtimeEpoch) {
      return false;
    }
    const transitionSource =
      source === "clear" || source === "resume" ? source : null;
    let authorization = handle?.agentSessionRotation ?? null;
    if (handle && authorization && authorization.expiresAt <= Date.now()) {
      handle.agentSessionRotation = null;
      authorization = null;
    }
    const matchesAuthorization =
      transitionSource !== null && authorization?.source === transitionSource;

    // A matching clear/resume SessionStart consumes the user gesture even
    // when this is the first vendor id, Claude keeps the same id, or the
    // proposed target is rejected below. It can never authorize a second pin.
    if (handle && matchesAuthorization) {
      handle.agentSessionRotation = null;
    }

    if (session.agentSessionId !== null) {
      const sameIdentity = session.agentSessionId === agentSessionId;
      if (sameIdentity) return true;
      if (!matchesAuthorization) return false;
    } else if (transitionSource !== null && !matchesAuthorization) {
      // A clear/resume-shaped first pin is a transition too. Without the
      // trusted gesture it is just model-authored hook text and must not get
      // the looser ordinary-startup initial-pin treatment.
      return false;
    }
    const digest = this.agentSessionIdentityDigest(agentSessionId);
    const ownerId = this.agentSessionOwners.get(digest);
    // Includes historical aliases from rotations, not just current public
    // pointers. A fresh session can therefore never reclaim A's old id and
    // merge its events/transcript with A after a restart.
    if (ownerId !== undefined && ownerId !== id) return false;
    if (ownerId === undefined)
      await this.reserveAgentSessionIdentity(digest, id);

    const candidate = { ...session, agentSessionId };
    let releaseFence: () => void = () => {};
    const fence = new Promise<void>((resolveFence) => {
      releaseFence = resolveFence;
    });
    this.sessionRegistryIdentityFence = fence;
    try {
      // The ingest request is not accepted into the event pipeline until both
      // the ownership tombstone and public current pointer are durable. The
      // sidecar is written first, so a crash between files fails closed. The
      // candidate remains private until this write commits; ordinary session
      // snapshots wait on the fence and therefore cannot resurrect a rejected
      // pointer or erase an accepted one.
      await this.persistIdentityCandidate(candidate);
      session.agentSessionId = agentSessionId;
    } finally {
      this.sessionRegistryIdentityFence = null;
      releaseFence();
    }
    this.emitStatus(session);
    return true;
  }

  /**
   * Fold trusted host/UI input into one bounded command line. Only callers
   * that already crossed the boot-token terminal WS or protected/internal
   * submitInput boundary reach this method; raw ingest tokens cannot arm it.
   * Unsupported controls and pasted/multiline content fail closed for the
   * current line. Picker navigation after an exact `/resume` does not revoke
   * the already-armed one-shot authorization.
   */
  private observeTrustedTerminalInput(handle: PtyHandle, data: string): void {
    const pickerAuthorization = handle.agentSessionRotation;
    if (
      data.length > 0 &&
      pickerAuthorization?.source === "resume" &&
      pickerAuthorization.refreshOnInput
    ) {
      const now = Date.now();
      if (pickerAuthorization.hardExpiresAt <= now) {
        handle.agentSessionRotation = null;
      } else {
        // Picker navigation/search/selection is a fresh host-owned gesture.
        // It may revive the soft window after the user paused to read, but it
        // can never extend the original bounded picker lifetime.
        pickerAuthorization.expiresAt = Math.min(
          now + AGENT_SESSION_ROTATION_TTL_MS,
          pickerAuthorization.hardExpiresAt,
        );
      }
    }
    for (const char of data) {
      if (handle.trustedInputEscape !== "") {
        handle.trustedInputEscape += char;
        const control = handle.trustedInputEscape;
        const possibleControls = handle.trustedInputPasting
          ? [BRACKETED_PASTE_END]
          : [BRACKETED_PASTE_START, BRACKETED_PASTE_END];
        if (
          possibleControls.some((candidate) => candidate.startsWith(control))
        ) {
          if (control === BRACKETED_PASTE_START) {
            handle.trustedInputPasting = true;
            handle.trustedInputLine = "";
            handle.trustedInputInvalid = true;
            handle.trustedInputEscape = "";
          } else if (control === BRACKETED_PASTE_END) {
            handle.trustedInputPasting = false;
            // A pasted slash command stays ineligible when the user presses
            // Enter after the closing marker.
            handle.trustedInputLine = "";
            handle.trustedInputInvalid = true;
            handle.trustedInputEscape = "";
          }
          continue;
        }
        // Unknown escape/control sequence. It cannot authorize this line;
        // while inside a paste, keep ignoring content until the real end.
        handle.trustedInputEscape = "";
        handle.trustedInputInvalid = true;
        continue;
      }
      if (char === "\x1b") {
        handle.trustedInputEscape = char;
        handle.trustedInputInvalid = true;
        continue;
      }
      if (handle.trustedInputPasting) {
        // In particular, CR inside a multiline paste is content, not trusted
        // Enter, and must never reset invalid state or arm an inner `/clear`.
        continue;
      }
      if (char === "\r") {
        if (!handle.trustedInputInvalid) {
          const transition = this.rotationForTrustedLine(
            handle.trustedInputLine,
          );
          if (transition) {
            const now = Date.now();
            handle.agentSessionRotation = {
              source: transition.source,
              expiresAt: now + AGENT_SESSION_ROTATION_TTL_MS,
              hardExpiresAt:
                now +
                (transition.picker
                  ? AGENT_SESSION_PICKER_ROTATION_MAX_MS
                  : AGENT_SESSION_ROTATION_TTL_MS),
              refreshOnInput: transition.picker,
            };
          }
        }
        handle.trustedInputLine = "";
        handle.trustedInputInvalid = false;
        continue;
      }
      // A literal LF is pasted/multiline content, not the terminal's Enter
      // key (which is CR). Reset fail-closed without authorizing an inner line.
      if (char === "\n") {
        handle.trustedInputLine = "";
        handle.trustedInputInvalid = true;
        continue;
      }
      if (char === "\x7f" || char === "\b") {
        if (!handle.trustedInputInvalid) {
          handle.trustedInputLine = handle.trustedInputLine.slice(0, -1);
        }
        continue;
      }
      // Ctrl-U clears the current composer; Ctrl-C abandons it. Neither
      // revokes a command already submitted (notably `/resume` picker mode).
      if (char === "\x15" || char === "\x03") {
        handle.trustedInputLine = "";
        handle.trustedInputInvalid = false;
        continue;
      }
      // Escape sequences, tabs, paste wrappers, and other controls are not
      // required to type either exact command and therefore fail closed.
      if (char < " " || char === "\x7f") {
        handle.trustedInputInvalid = true;
        continue;
      }
      if (handle.trustedInputInvalid) continue;
      if (handle.trustedInputLine.length >= TRUSTED_INPUT_LINE_MAX) {
        handle.trustedInputLine = "";
        handle.trustedInputInvalid = true;
        continue;
      }
      handle.trustedInputLine += char;
    }
  }

  /** A protected discrete submit owns its final synthetic CR separately from
   * the text phase. Embedded CR/LF is multiline prompt content, never a series
   * of trusted Enter gestures: invalidate the whole submitted text so neither
   * raw nor bracketed transport can smuggle an inner `/clear` or `/resume`. */
  private observeTrustedSubmittedText(handle: PtyHandle, text: string): void {
    if (text.includes("\r") || text.includes("\n")) {
      handle.trustedInputLine = "";
      handle.trustedInputInvalid = true;
      return;
    }
    this.observeTrustedTerminalInput(handle, text);
  }

  private rotationForTrustedLine(
    line: string,
  ): { source: "clear" | "resume"; picker: boolean } | null {
    if (line === "/clear") return { source: "clear", picker: false };
    if (line === "/resume") return { source: "resume", picker: true };
    if (
      line.startsWith("/resume ") &&
      line.slice("/resume ".length).trim().length > 0
    ) {
      return { source: "resume", picker: false };
    }
    return null;
  }

  /**
   * Marks a session's TUI as genuinely interactive — see `HarnessSession.ready`.
   * Called either from the ingest pipeline when a SessionStart(-equivalent)
   * event is processed for this session (real hook for Claude Code, tailer-
   * translated for Codex), or from an adapter-declared readiness fallback.
   * Idempotent; a session that's exited or already ready is a silent no-op.
   */
  setReady(id: string, runtimeEpoch?: string): void {
    const session = this.sessions.get(id);
    if (
      !session ||
      session.status === "exited" ||
      session.ready ||
      (runtimeEpoch !== undefined &&
        this.ptys.get(id)?.runtimeEpoch !== runtimeEpoch)
    )
      return;
    session.ready = true;
    void this.persist();
    this.emitStatus(session);
  }

  /** Persist a coordinator-owned metadata projection before exposing it. */


  /** Persist the neutral project-bootstrap projection before exposing it. */
  async setProjectBootstrapMetadata(
    id: string,
    metadata: ProjectBootstrapMetadata,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new UnknownSessionError(id);
    session.projectBootstrap = structuredClone(metadata);
    await this.persist();
    this.emitStatus(session);
  }

  /**
   * Whether `id` should be treated as ready to receive programmatic input
   * right now. A real/fallback `session.ready` signal normally suffices; an
   * immediate-fallback adapter gets one last recognized-blocker scan because
   * readiness is latched while its TUI can still paint a late onboarding
   * frame. Before readiness, immediate and legacy detect-only adapters require
   * at least `READY_SETTLE_MS` of quiet output (or the bounded liveness
   * ceiling) and a clean recent-screen view. Claude Code has no immediate
   * shortcut — its SessionStart hook (or preserved 20-second hook-timeout
   * path) controls readiness.
   */
  private isReadyEnough(session: HarnessSession, handle: PtyHandle): boolean {
    const adapter = this.adapters[session.harness];
    // `ready` is intentionally latched for persistence and status broadcasts,
    // but an immediate-fallback harness can still paint a late onboarding
    // screen after readiness was inferred. Recheck its latest frame before
    // every programmatic write; raw terminal input remains ungated so the user
    // can answer the screen. Real-signal/hook-timeout adapters keep their
    // existing ready semantics unchanged.
    if (session.ready) {
      return (
        adapter?.readyFallback !== "immediate" ||
        !this.hasCurrentBlockingPrompt(adapter, handle)
      );
    }
    // Gated on the DECLARED fallback mode, not on detectBlockingPrompt's mere
    // presence: claude-code now implements detectBlockingPrompt too (for the
    // hook-timeout fallback armed in spawn()), and giving it this immediate
    // shortcut would bypass its reliable SessionStart hook everywhere.
    //
    // `readyFallback` is optional on the PUBLIC HarnessAdapter interface and
    // hosts may inject their own adapters, so an external one predating the
    // field would silently lose its only pre-ready injection path. Treat
    // detectBlockingPrompt-without-readyFallback as the legacy "immediate"
    // contract it used to imply.
    if (!adapter?.detectBlockingPrompt) return false;
    if (
      adapter.readyFallback !== undefined &&
      adapter.readyFallback !== "immediate"
    )
      return false;
    if (adapter.readyFallback === "immediate") {
      if (!this.isImmediateFallbackSettled(handle)) return false;
      return !this.hasImmediateBlockingPrompt(adapter, handle);
    }
    if (
      handle.lastOutputAt === null ||
      Date.now() - handle.lastOutputAt < READY_SETTLE_MS
    )
      return false;
    return !this.hasRetainedBlockingPrompt(adapter, handle);
  }

  private isImmediateFallbackSettled(handle: PtyHandle): boolean {
    if (handle.readinessCandidateAt === null || handle.lastOutputAt === null)
      return false;
    const now = Date.now();
    const hitCeiling =
      now - handle.readinessCandidateAt >= READY_SETTLE_CEILING_MS;
    const completedFrameSettled =
      handle.pendingReadinessFrame === null &&
      now - handle.lastOutputAt >= READY_SETTLE_MS;
    return hitCeiling || completedFrameSettled;
  }

  /** The best available current frame, excluding older diff repaint history.
   * Used after readiness has latched so ordinary agent output that quotes old
   * onboarding copy cannot permanently gate later writes. */
  private currentReadinessOutput(handle: PtyHandle): string {
    const output =
      handle.pendingReadinessFrame ??
      handle.readinessBuffer + handle.pendingReadinessPrefix;
    return output.slice(-BLOCKING_PROMPT_SCAN_BYTES);
  }

  /** A bounded union of recent diff repaints, including an unfinished current
   * repaint. This is intentionally only used before immediate readiness. */
  private recentReadinessOutput(handle: PtyHandle): string {
    const pending =
      handle.pendingReadinessFrame ?? handle.pendingReadinessPrefix;
    return `${handle.readinessHistory}\n${pending}`.slice(
      -BLOCKING_PROMPT_SCAN_BYTES,
    );
  }

  /** Preserve a recognized blocker across Ratatui's partial row repaints. The
   * latch is cleared only by a positive empty-composer match in a clean current
   * frame; merely failing to re-render every phrase is not evidence that the
   * screen was dismissed. */
  private refreshImmediatePromptState(
    adapter: HarnessAdapter,
    handle: PtyHandle,
  ): void {
    if (
      adapter.readyFallback !== "immediate" ||
      !adapter.detectBlockingPrompt ||
      !adapter.detectReadyPrompt
    ) {
      return;
    }

    const current = this.currentReadinessOutput(handle);
    const recent = this.recentReadinessOutput(handle);
    if (adapter.detectBlockingPrompt(recent)) handle.blockingPromptSeen = true;
    if (!handle.blockingPromptSeen) return;
    // The ceiling applies only to a continuously non-blocking candidate. If a
    // user leaves onboarding open for a minute, that elapsed minute must not
    // make the first clean repaint after dismissal ready immediately.
    handle.readinessCandidateAt = null;

    if (
      adapter.detectReadyPrompt(current) &&
      !adapter.detectBlockingPrompt(current)
    ) {
      handle.blockingPromptSeen = false;
      handle.readinessCandidateAt = handle.lastOutputAt ?? Date.now();
      // Once the real composer is visible, older onboarding frames are no
      // longer part of the current screen and must not be re-latched later.
      handle.readinessHistory = current;
    }
  }

  private hasImmediateBlockingPrompt(
    adapter: HarnessAdapter,
    handle: PtyHandle,
  ): boolean {
    if (!adapter.detectReadyPrompt) {
      const blocked = this.hasRetainedBlockingPrompt(adapter, handle);
      if (blocked) handle.readinessCandidateAt = null;
      return blocked;
    }
    this.refreshImmediatePromptState(adapter, handle);
    return handle.blockingPromptSeen;
  }

  /** The original readiness-buffer check retained for Claude's hook-timeout
   * and legacy detect-only adapters. Their fallback semantics must not change
   * merely because Codex needs partial-frame reconstruction. */
  private hasRetainedBlockingPrompt(
    adapter: HarnessAdapter,
    handle: PtyHandle,
  ): boolean {
    return (
      adapter.detectBlockingPrompt?.(
        handle.readinessBuffer.slice(-BLOCKING_PROMPT_SCAN_BYTES),
      ) ?? false
    );
  }

  /** Scan only the best available current frame; dismissed full-screen prompts
   * remain in older scrollback forever and must not block already-ready input. */
  private hasCurrentBlockingPrompt(
    adapter: HarnessAdapter,
    handle: PtyHandle,
  ): boolean {
    return (
      adapter.detectBlockingPrompt?.(this.currentReadinessOutput(handle)) ??
      false
    );
  }

  /**
   * Polls `isReadyEnough` until it's true, the session's pty goes away
   * (killed/exited — it's never going to become ready now), or `timeoutMs`
   * elapses. Used by `submitInput()` only — `write()` (raw terminal
   * keystrokes) must never wait on this, since a human answering the very
   * prompt this is waiting out is exactly how a session becomes ready.
   */
  private async waitUntilReady(
    id: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const handle = this.ptys.get(id);
      const session = this.sessions.get(id);
      if (!handle || !session) return false;
      if (this.isReadyEnough(session, handle)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  /** Waits for all in-flight registry writes to settle. Useful before process
   * shutdown (and in tests that assert against the on-disk registry). */
  async flush(): Promise<void> {
    // Project-session creation owns setup and registry writes that may span
    // several awaits. Shutdown closes admission first, then waits for every
    // already-queued publication to settle before considering persistence
    // drained.
    while (this.projectCreateQueues.size > 0) {
      await Promise.all([...this.projectCreateQueues.values()]);
    }
    await this.agentSessionIdentityQueue;
    await this.subsessionBindingQueue;
    await this.writeQueue;
  }

  setTitle(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (!session || !title || session.title === title) return;
    session.title = title;
    void this.persist();
    this.emitStatus(session);
  }

  /** Binds (or, with `null`, unbinds) the session's current workflow
   *  selection. The caller (rest.ts) owns validating `workflowPath` against
   *  the workflow registry and mirroring the binding into
   *  HARNESS_CONTEXT_FILE — this only updates the in-memory/persisted
   *  registry entry and broadcasts the change like any other status update. */
  setBoundWorkflowPath(id: string, workflowPath: string | null): void {
    const session = this.sessions.get(id);
    if (!session || session.boundWorkflowPath === workflowPath) return;
    session.boundWorkflowPath = workflowPath;
    void this.persist();
    this.emitStatus(session);
  }

  private async spawn(
    session: HarnessSession,
    spec: SpawnSpec,
    revalidateAdmission?: () => Promise<void>,
  ): Promise<void> {
    if (this.closing) throw new SessionManagerClosingError();
    const adapter = this.getAdapter(session.harness);
    const spawnFn = this.spawnPty ?? (await this.loadSpawnPty());
    // Loading node-pty is lazy and asynchronous. Revalidate the project
    // principal only after that final setup await; a binding or authenticated
    // user can change while the module loads. The closing check follows the
    // authorization await and then admission remains synchronous, so
    // beginShutdown/killAll cannot miss a newly admitted process either.
    await revalidateAdmission?.();
    if (this.closing) throw new SessionManagerClosingError();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env[HOST_ESBUILD_PIN];
    for (const [key, value] of Object.entries(spec.env)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    // The PTY is a real colour-capable xterm, regardless of the shell that
    // launched Studio. Desktop development is often started from CI-like
    // hosts (Codex included) that export NO_COLOR=1 and TERM=dumb for their
    // own logs. Letting those ambient values leak into Claude/Codex makes the
    // embedded terminal monochrome even though xterm can render the full ANSI
    // palette. Own the terminal capability contract at this boundary.
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env[ENV.ingestUrl] = `${this.ingestUrl.replace(/\/$/, "")}/ingest`;
    const ingestCredential = this.issueIngestCredential(session.id);
    this.adapterIdentityStates.set(session.id, {
      runtimeEpoch: ingestCredential.runtimeEpoch,
      state: adapter.eventSource === "transcript-tail" ? "pending" : "not-required",
    });
    env[ENV.ingestToken] = ingestCredential.token;
    env[ENV.sessionId] = session.id;
    if (this.collectorUrl) env[ENV.collectorUrl] = this.collectorUrl;

    // On Windows a bare command name (or a .cmd shim, which is what npm installs
    // for `claude`) cannot be spawned: node-pty uses CreateProcess, which does no
    // PATHEXT resolution and can't execute a .cmd. resolveSpawnTarget RESOLVES the
    // shim to its real target — deliberately NOT via cmd.exe, which would expose
    // these arguments to shell parsing (command injection; see that module).
    // No-op on POSIX.
    const target = resolveSpawnTarget(spec.command, spec.args);

    let epochTransitioned = false;
    let pty: IPty;
    try {
      // The coordinator must durably retire every owner from the prior PTY
      // generation before this replacement becomes observable. Its epoch is
      // server-generated beside the private ingest capability and never comes
      // from a hook, model payload, or browser request.
      await this.onRuntimeEpochTransition?.(
        { ...session },
        ingestCredential.runtimeEpoch,
      );
      epochTransitioned = true;
      // Epoch transition is fallible and may wait on durable state. Revalidate
      // project/user scope and shutdown admission once more after that await.
      await revalidateAdmission?.();
      if (this.closing) throw new SessionManagerClosingError();
      // A throw here — spawnFn itself, or loadDefaultSpawn() above (a broken
      // node-pty prebuild surfaces there, not at import time) — propagates to
      // create()/resume(), which own reconciling the session record to
      // "exited" for every pre-pty failure, not just this one.
      pty = spawnFn(target.command, target.args, {
        name: "xterm-256color",
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: spec.cwd,
        env,
      });
    } catch (error) {
      this.revokeIngestToken(session.id);
      const identityState = this.adapterIdentityStates.get(session.id);
      if (identityState?.runtimeEpoch === ingestCredential.runtimeEpoch)
        this.adapterIdentityStates.delete(session.id);
      if (epochTransitioned) {
        await Promise.resolve(
          this.onRuntimeEpochTransition?.({ ...session }, null),
        ).catch(() => {});
      }
      throw error;
    }

    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const handle: PtyHandle = {
      pty,
      runtimeEpoch: ingestCredential.runtimeEpoch,
      buffer: "",
      readinessBuffer: "",
      readinessHistory: "",
      blockingPromptSeen: false,
      pendingReadinessPrefix: "",
      pendingReadinessFrame: null,
      pendingReadinessFrameHasContent: false,
      emitter,
      spawnedAt: Date.now(),
      readinessCandidateAt: null,
      lastOutputAt: null,
      bracketedPaste: initialBracketedPasteState,
      trustedInputLine: "",
      trustedInputInvalid: false,
      trustedInputPasting: false,
      trustedInputEscape: "",
      agentSessionRotation: null,
      exited,
      resolveExited,
      killed: false,
    };
    this.retiredRuntimeEpochs.delete(session.id);
    this.ptys.set(session.id, handle);

    session.status = "running";
    // A resumed session may carry `ready: true` from its previous life —
    // this is a fresh pty that hasn't proven itself interactive yet either
    // way (trust dialogs can reappear, e.g. under different sandbox flags).
    session.ready = false;
    session.lastActiveAt = this.now();
    await this.persist();
    this.emitStatus(session);

    pty.onData((chunk) => {
      handle.bracketedPaste = trackBracketedPaste(handle.bracketedPaste, chunk);
      handle.buffer = (handle.buffer + chunk).slice(-SCROLLBACK_BYTES);
      this.recordReadinessOutput(handle, chunk, adapter);
      handle.emitter.emit("data", chunk);
      this.recordActivity(session.id);
    });

    pty.onExit(({ exitCode }) => this.markExited(session.id, handle, exitCode));

    this.armReadyFallback(session.id, handle);
  }

  /**
   * Publishes adapter-declared fallback readiness so the SPA's held first
   * prompt can be released even when the harness's real lifecycle signal
   * cannot arrive yet (Codex) or never arrived (Claude Code with a broken
   * SessionStart hook).
   *
   * Both modes are conservative on purpose:
   *  - requires SOME output — a pty that hasn't drawn anything yet isn't an
   *    interactive TUI, it's still starting;
   *  - keeps waiting while an adapter-recognized blocking prompt is on screen,
   *    so known trust/login/setup screens are not answered by injected input;
   *  - dies with the handle (exit clears the interval; a replaced handle is
   *    detected via the ptys map, same idempotency rule as markExited()).
   *
   * `"immediate"` (Codex) reuses the same quiet-window/ceiling and frame rule
   * as `isReadyEnough()`, but proactively calls `setReady()` once output is
   * stable or reaches the bounded liveness ceiling. That status event closes
   * the first-prompt deadlock:
   * Codex writes no rollout/session_meta before turn one, while the SPA waits
   * for `ready` before submitting turn one. Only an EXPLICIT declaration arms
   * this persistent state transition; detect-only legacy adapters retain their
   * request-time `isReadyEnough()` compatibility path without being promoted.
   *
   * `"hook-timeout"` (Claude Code) retains its generous 20s delay: a healthy
   * hook (1–3s) always wins the race, so behaviour only changes on machines
   * where the hook is already broken.
   */
  private armReadyFallback(id: string, handle: PtyHandle): void {
    const session = this.sessions.get(id);
    const adapter = session ? this.adapters[session.harness] : undefined;
    if (!adapter) return;
    const mode = adapter.readyFallback;
    if (mode !== "immediate" && mode !== "hook-timeout") return;
    // An immediate promotion is only safe when the adapter can positively
    // exclude its own known blocking screens. Hook-timeout preserves its
    // existing optional-detector behaviour for third-party adapters.
    if (mode === "immediate" && !adapter.detectBlockingPrompt) return;

    const pollMs = mode === "immediate" ? READY_POLL_MS : HOOK_READY_POLL_MS;

    const poll = setInterval(() => {
      const current = this.sessions.get(id);
      if (
        !current ||
        this.ptys.get(id) !== handle ||
        current.status !== "running"
      ) {
        clearInterval(poll);
        return;
      }
      if (current.ready) {
        clearInterval(poll);
        return;
      }
      if (mode === "immediate") {
        if (!this.isImmediateFallbackSettled(handle)) return;
      } else {
        // Preserve Claude's original fallback contract exactly: 20 seconds
        // from spawn and at least one output byte, without a quiet-window
        // requirement layered on top.
        if (Date.now() - handle.spawnedAt < HOOK_READY_FALLBACK_MS) return;
        if (!handle.buffer) return;
      }
      const hasBlockingPrompt =
        mode === "immediate"
          ? this.hasImmediateBlockingPrompt(adapter, handle)
          : this.hasRetainedBlockingPrompt(adapter, handle);
      if (hasBlockingPrompt) return;
      clearInterval(poll);
      if (mode === "hook-timeout") {
        console.warn(
          `[harness] session ${id}: SessionStart hook never reached /ingest after ${
            HOOK_READY_FALLBACK_MS / 1000
          }s — marking ready by fallback. The hook command may be failing on this machine ` +
            `(is \`node\` resolvable from the agent's hook shell?).`,
        );
      }
      this.setReady(id, handle.runtimeEpoch);
    }, pollMs);
    // Never the reason the process stays alive; tests with fake timers and
    // the real server both tear down via the exited hook below anyway.
    poll.unref?.();
    void handle.exited.then(() => clearInterval(poll));
  }

  /**
   * Transitions a session to "exited". Shared by node-pty's own `onExit`
   * callback and `kill()`'s missed-event fallback (see `kill()`) — both are
   * racing to be the one that reports a given pty's death, so this is
   * idempotent: a stale/duplicate call (`this.ptys.get(id) !== handle`,
   * i.e. this handle was already replaced or already reported exited) is a
   * silent no-op rather than double-transitioning or clobbering a newer
   * session/handle that's since taken its place (e.g. a resume).
   */
  private markExited(
    id: string,
    handle: PtyHandle,
    exitCode: number | null,
  ): void {
    if (this.ptys.get(id) !== handle) return;
    // Preserve the tail of output BEFORE the handle (and its buffer) is dropped
    // — this is the only chance to keep the agent's own error line. Worth it
    // only for a genuine, unprompted non-zero exit: a clean exit (0) has
    // nothing to diagnose, and a death WE caused (`handle.killed`, or a
    // synthesized null exit from kill()/sweep) is not a crash whose reason the
    // output would explain — even if node-pty reports a non-zero signal code
    // for it. Best-effort: it captures whatever onData has delivered into
    // `handle.buffer` by now, which for a fast startup crash is normally the
    // error banner, but a build that exits before its final chunk drains can
    // leave it short (hence `sanitizeExitTail` returning null over an empty box).
    const exitTail =
      !handle.killed && exitCode != null && exitCode !== 0
        ? sanitizeExitTail(handle.buffer)
        : null;
    this.ptys.delete(id);
    const identityState = this.adapterIdentityStates.get(id);
    if (identityState?.runtimeEpoch === handle.runtimeEpoch)
      this.adapterIdentityStates.delete(id);
    this.retiredRuntimeEpochs.set(id, handle.runtimeEpoch);
    this.lastActivityBroadcast.delete(id);
    // Resolve after the pty map is cleaned up. transitionExited runs
    // synchronously to set status before any awaiting continuation resumes.
    handle.resolveExited();
    const session = this.sessions.get(id);
    if (!session) return;
    void this.transitionExited(session, exitCode, {
      exitTail,
      runtimeEpoch: handle.runtimeEpoch,
    });
  }

  /**
   * The single place a session record flips to "exited" — shared by
   * `markExited()` (live-pty deaths), `create()`/`resume()`'s pre-pty
   * failure reconciliation, `kill()`'s stale-record path, and
   * `sweepDeadSessions()`. Returns the persist promise so callers that need
   * the registry durably updated before rethrowing (create/resume) can
   * await it; event-driven callers fire-and-forget it like any other write.
   */
  private transitionExited(
    session: HarnessSession,
    exitCode: number | null,
    {
      stampLastActive = true,
      exitTail = null,
      runtimeEpoch = null,
    }: {
      stampLastActive?: boolean;
      exitTail?: string | null;
      runtimeEpoch?: string | null;
    } = {},
  ): Promise<void> {
    this.revokeIngestToken(session.id);
    try {
      void Promise.resolve(this.onAgentMapSessionExit?.(session.id)).catch(
        () => {},
      );
    } catch {
      // Capability cleanup never delays durable session reconciliation.
    }
    session.status = "exited";
    session.exitCode = exitCode;
    // Only markExited (a live-pty death) has output to preserve; every other
    // caller (pre-pty create/resume failure, kill()'s ghost path, the sweep)
    // passes nothing, which clears any stale tail from a previous life — a
    // resume that fails before spawning must not still show the last crash's.
    session.exitTail = exitTail;
    // `stampLastActive: false` is for reconciling a resume that never got a
    // pty: "we noticed it's dead" is not activity, and stamping it there is
    // what made an untouched session's duration grow on every failed Resume.
    if (stampLastActive) session.lastActiveAt = this.now();
    const persisted = this.persist();
    this.emitStatus(session, runtimeEpoch);
    return persisted;
  }

  private emitStatus(
    session: HarnessSession,
    runtimeEpoch = this.getRuntimeEpoch(session.id),
  ): void {
    this.statusEmitter.emit(
      "status",
      { ...session },
      { runtimeEpoch } satisfies SessionStatusContext,
    );
  }

  private agentSessionIdentityDigest(agentSessionId: string): string {
    return createHash("sha256").update(agentSessionId, "utf8").digest("hex");
  }

  private serializeAgentSessionIdentity<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const next = this.agentSessionIdentityQueue
      .catch(() => {})
      .then(operation);
    this.agentSessionIdentityQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /** Load the private alias ledger before accepting ingest. Missing is the
   * one recoverable case (upgrade from an older build): current pointers seed
   * it exactly once, with sessions.json order deterministically choosing the
   * first owner of a legacy duplicate. Malformed/unreadable ledger state still
   * fails boot rather than silently forgetting rotation tombstones. */
  private async loadAgentSessionOwners(
    persisted: HarnessSession[],
  ): Promise<boolean> {
    let needsWrite = false;
    let pointersDirty = false;
    try {
      const raw = await readFile(this.agentSessionOwnersPath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > AGENT_SESSION_OWNER_MAX_BYTES) {
        throw new Error("agent-session owner ledger exceeds its size limit");
      }
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !== "owners,version"
      ) {
        throw new Error("agent-session owner ledger has an invalid shape");
      }
      const record = parsed as { version?: unknown; owners?: unknown };
      if (
        record.version !== AGENT_SESSION_OWNER_FILE_VERSION ||
        typeof record.owners !== "object" ||
        record.owners === null ||
        Array.isArray(record.owners)
      ) {
        throw new Error(
          "agent-session owner ledger has an unsupported version",
        );
      }
      const entries = Object.entries(record.owners as Record<string, unknown>);
      if (entries.length > AGENT_SESSION_OWNER_MAX_ENTRIES) {
        throw new Error("agent-session owner ledger exceeds its entry limit");
      }
      for (const [digest, ownerId] of entries) {
        if (
          !/^[a-f0-9]{64}$/u.test(digest) ||
          typeof ownerId !== "string" ||
          ownerId.length === 0 ||
          ownerId.length > 256
        ) {
          throw new Error(
            "agent-session owner ledger contains an invalid entry",
          );
        }
        this.agentSessionOwners.set(digest, ownerId);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      needsWrite = true;
    }

    // Preserve persisted array order: released versions could create two rows
    // with the same vendor id, so the first recorded owner wins the one-time
    // upgrade. When a ledger already exists it is authoritative instead.
    for (const session of persisted) {
      if (!session.agentSessionId) continue;
      const digest = this.agentSessionIdentityDigest(session.agentSessionId);
      const ownerId = this.agentSessionOwners.get(digest);
      if (ownerId !== undefined && ownerId !== session.id) {
        session.agentSessionId = null;
        pointersDirty = true;
        continue;
      }
      if (ownerId === undefined) {
        this.agentSessionOwners.set(digest, session.id);
        needsWrite = true;
      }
    }
    if (needsWrite) await this.persistAgentSessionOwners();
    return pointersDirty;
  }

  private async reserveAgentSessionIdentity(
    digest: string,
    sessionId: string,
  ): Promise<void> {
    const ownerId = this.agentSessionOwners.get(digest);
    if (ownerId === sessionId) return;
    if (ownerId !== undefined) {
      throw new AgentSessionIdentityReservedError();
    }
    this.agentSessionOwners.set(digest, sessionId);
    // Atomic rename can commit and still surface an ambiguous later I/O
    // failure. Retain the in-memory claim so this process never lets another
    // session overwrite a possibly durable owner. A clean pre-commit failure
    // therefore also fails closed until restart, which is the safe tradeoff.
    await this.persistAgentSessionOwners();
  }

  private async persistAgentSessionOwners(): Promise<void> {
    const owners = Object.fromEntries(
      [...this.agentSessionOwners.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
    const serialized = `${JSON.stringify(
      { version: AGENT_SESSION_OWNER_FILE_VERSION, owners },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(serialized, "utf8") > AGENT_SESSION_OWNER_MAX_BYTES) {
      throw new Error("agent-session owner ledger exceeds its size limit");
    }
    if (this.writeAgentSessionOwnerRegistry) {
      await this.writeAgentSessionOwnerRegistry(
        this.agentSessionOwnersPath,
        serialized,
      );
      return;
    }
    await mkdir(dirname(this.agentSessionOwnersPath), { recursive: true });
    const tmpPath = `${this.agentSessionOwnersPath}.tmp-${process.pid}-${
      this.agentSessionOwnerWriteSeq++
    }`;
    await writeFile(tmpPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, this.agentSessionOwnersPath);
  }

  private async loadSubsessionBindings(): Promise<void> {
    let decoded: unknown;
    try {
      const raw = await readFile(this.subsessionBindingsPath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > SUBSESSION_BINDING_MAX_BYTES)
        throw new Error("subsession binding registry exceeds its size limit");
      decoded = JSON.parse(raw) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !isRecord(decoded) ||
      Object.keys(decoded).sort().join(",") !==
        "closedSessionIds,markers,version" ||
      decoded.version !== SUBSESSION_BINDING_FILE_VERSION ||
      !isRecord(decoded.markers) ||
      !Array.isArray(decoded.closedSessionIds) ||
      decoded.closedSessionIds.length > SUBSESSION_BINDING_MAX_ENTRIES ||
      !decoded.closedSessionIds.every(
        (sessionId) => typeof sessionId === "string",
      )
    ) {
      throw new Error("subsession binding registry is malformed");
    }
    const entries = Object.entries(decoded.markers);
    if (entries.length > SUBSESSION_BINDING_MAX_ENTRIES)
      throw new Error("subsession binding registry exceeds its entry limit");
    const bindingIds = new Set<string>();
    for (const [sessionId, value] of entries) {
      const marker = parseTrustedSubsessionBindingMarker(value, sessionId);
      if (!marker || bindingIds.has(marker.bindingId))
        throw new Error("subsession binding registry is malformed");
      bindingIds.add(marker.bindingId);
      this.subsessionBindings.set(sessionId, marker);
    }
    for (const sessionId of decoded.closedSessionIds) {
      if (!this.subsessionBindings.has(sessionId))
        throw new Error("subsession binding registry is malformed");
      this.userClosedSubsessions.add(sessionId);
    }
  }

  private async persistSubsessionBindings(): Promise<void> {
    const markers = Object.fromEntries(
      [...this.subsessionBindings.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionId, marker]) => [sessionId, marker]),
    );
    const serialized = `${JSON.stringify(
      {
        version: SUBSESSION_BINDING_FILE_VERSION,
        markers,
        closedSessionIds: [...this.userClosedSubsessions].sort(),
      },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(serialized, "utf8") > SUBSESSION_BINDING_MAX_BYTES)
      throw new Error("subsession binding registry exceeds its size limit");
    if (this.writeSubsessionBindingRegistry) {
      await this.writeSubsessionBindingRegistry(
        this.subsessionBindingsPath,
        serialized,
      );
      return;
    }
    const directory = dirname(this.subsessionBindingsPath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.subsessionBindingsPath}.tmp-${process.pid}-${
      this.subsessionBindingWriteSeq++
    }`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.subsessionBindingsPath);
      await chmod(this.subsessionBindingsPath, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private persistIdentityCandidate(candidate: HarnessSession): Promise<void> {
    const current = this.list();
    const index = current.findIndex((session) => session.id === candidate.id);
    const proposed =
      index === -1
        ? [...current, candidate]
        : current.map((session) =>
            session.id === candidate.id ? candidate : session,
          );
    return this.enqueueRegistryWrite(JSON.stringify(proposed, null, 2) + "\n");
  }

  private enqueueRegistryWrite(
    serialized: string | (() => string),
    fence?: Promise<void>,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      if (fence) await fence;
      const content =
        typeof serialized === "string" ? serialized : serialized();
      if (this.writeSessionRegistry) {
        await this.writeSessionRegistry(this.sessionsPath, content);
        return;
      }
      await mkdir(dirname(this.sessionsPath), { recursive: true });
      const tmpPath = `${this.sessionsPath}.tmp-${process.pid}-${this.writeSeq++}`;
      await writeFile(tmpPath, content, "utf8");
      await rename(tmpPath, this.sessionsPath);
    };
    const next = this.writeQueue.catch(() => {}).then(run);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  /** Serializes writes so overlapping persist() calls can't interleave and
   * corrupt the registry file; a failed write doesn't poison later ones. */
  private persist(): Promise<void> {
    const fence = this.sessionRegistryIdentityFence;
    if (fence) {
      // Capturing an ordinary mutation while a private identity candidate is
      // unresolved could persist the uncommitted pointer (if memory were
      // mutated) or overwrite a successful commit with its old value. Wait,
      // then snapshot the authoritative published map at execution time.
      return this.enqueueRegistryWrite(
        () => JSON.stringify(this.list(), null, 2) + "\n",
        fence,
      );
    }
    // Outside an identity transaction, capture at call time: queued writes
    // represent the mutation that requested them, not an unrelated later one.
    return this.enqueueRegistryWrite(
      JSON.stringify(this.list(), null, 2) + "\n",
    );
  }

  private readonly prepareProjectSession: SessionManagerOptions["prepareProjectSession"];

  private readonly onProjectBootstrapSession: SessionManagerOptions["onProjectBootstrapSession"];

  /** Publish project sessions in claim order so the first durable/visible row
   * is also the one that owns the first-session lifecycle. */
  private readonly projectCreateQueues = new Map<string, Promise<void>>();

  private readonly pendingCreates = new Map<
    string,
    Pick<HarnessSession, "cwd" | "agentMapIdentity">
  >();


  /** Read-only vendor-history probe used before a coordinator claims recovery. */
  async canResumeSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session?.agentSessionId) return false;
    return this.getAdapter(session.harness).canResume(
      session.agentSessionId,
      session.cwd,
    );
  }


  private serializeProjectCreate<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.projectCreateQueues.get(projectId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.projectCreateQueues.set(projectId, settled);
    void settled.then(() => {
      if (this.projectCreateQueues.get(projectId) === settled) {
        this.projectCreateQueues.delete(projectId);
      }
    });
    return next;
  }


  /** Keep ordinary project roots discoverable during asynchronous launch
   * preparation, before their session rows can be published. Server-only. */
  listPendingCreates(): Pick<HarnessSession, "cwd" | "agentMapIdentity">[] {
    return [...this.pendingCreates.values()];
  }

  /**
   * Server-only reserved-ID create. The private marker is committed before a
   * session row or process can exist, closing the row-before-binding crash
   * window while preserving the ordinary writable create path.
   */
  async createReserved(
    reservedSessionId: string,
    req: CreateSessionRequest,
    markerInput: TrustedSubsessionBindingMarker,
    trusted: TrustedSessionCreateOptions,
  ): Promise<HarnessSession> {
    const marker = parseTrustedSubsessionBindingMarker(
      markerInput,
      reservedSessionId,
    );
    if (!marker) throw new SubsessionBindingMismatchError();
    const operation = async (): Promise<HarnessSession> => {
      const existingMarker = this.subsessionBindings.get(reservedSessionId);
      const existingSession = this.sessions.get(reservedSessionId);
      if (existingMarker) {
        if (!sameSubsessionBinding(existingMarker, marker))
          throw new SubsessionBindingMismatchError();
        if (this.userClosedSubsessions.has(reservedSessionId))
          throw new SubsessionFreshRestartForbiddenError();
        if (existingSession) return existingSession;
      } else {
        if (existingSession) throw new SubsessionBindingMismatchError();
        this.subsessionBindings.set(reservedSessionId, marker);
        try {
          await this.persistSubsessionBindings();
        } catch (error) {
          if (this.subsessionBindings.get(reservedSessionId) === marker)
            this.subsessionBindings.delete(reservedSessionId);
          throw error;
        }
      }
      return this.createWithId(reservedSessionId, req, trusted, marker);
    };
    const next = this.subsessionBindingQueue.catch(() => {}).then(operation);
    this.subsessionBindingQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  getSubsessionBinding(
    sessionId: string,
  ): TrustedSubsessionBindingMarker | null {
    const marker = this.subsessionBindings.get(sessionId);
    return marker ? structuredClone(marker) : null;
  }

  matchesSubsessionBinding(
    expected: TrustedSubsessionBindingMarker,
  ): boolean {
    const parsed = parseTrustedSubsessionBindingMarker(
      expected,
      expected.sessionId,
    );
    const current = parsed
      ? this.subsessionBindings.get(parsed.sessionId)
      : undefined;
    return Boolean(parsed && current && sameSubsessionBinding(current, parsed));
  }

  wasSubsessionClosedByUser(
    expected: TrustedSubsessionBindingMarker,
  ): boolean {
    return (
      this.matchesSubsessionBinding(expected) &&
      this.userClosedSubsessions.has(expected.sessionId)
    );
  }

  private async createWithId(
    id: string,
    req: CreateSessionRequest,
    trusted: TrustedSessionCreateOptions,
    expectedSubsessionBinding?: TrustedSubsessionBindingMarker,
  ): Promise<HarnessSession> {
    if (this.closing) throw new SessionManagerClosingError();
    const marker = this.subsessionBindings.get(id);
    if (
      (marker !== undefined || expectedSubsessionBinding !== undefined) &&
      (!marker ||
        !expectedSubsessionBinding ||
        !sameSubsessionBinding(marker, expectedSubsessionBinding))
    ) {
      throw new SubsessionBindingMismatchError();
    }
    if (this.sessions.has(id)) throw new SubsessionBindingMismatchError();
    const adapter = this.getAdapter(req.harness);
    const trustedIdentity = trusted.agentMapIdentity?.(id);
    const agentMapIdentity = this.resolveAgentMapIdentity
      ? await this.resolveAgentMapIdentity(id, req.cwd, trustedIdentity)
      : trustedIdentity;
    const createResolved = async (): Promise<HarnessSession> => {
      // A project create may have been waiting behind another publication
      // when shutdown closed admission. Refuse it before claiming bootstrap,
      // issuing capabilities, or writing generated session state.
      if (this.closing) throw new SessionManagerClosingError();
      let preparedProjectSession:
        | Awaited<
            ReturnType<
              NonNullable<SessionManagerOptions["prepareProjectSession"]>
            >
          >
        | undefined;
      let opts: LaunchOpts;
      let spec: SpawnSpec;
      try {
        preparedProjectSession =
          agentMapIdentity && this.prepareProjectSession
            ? await this.prepareProjectSession(agentMapIdentity, req)
            : undefined;
        if (
          trusted.requireProjectBootstrapClaim &&
          !preparedProjectSession?.projectBootstrap
        ) {
          throw new ProjectBootstrapClaimUnavailableError();
        }
        // Retain only AFTER claiming first-session ownership. Advertising the
        // root earlier could start an automatic session ahead of this request.
        this.pendingCreates.set(id, { cwd: req.cwd, agentMapIdentity });
        const promptAppendix = trusted.promptAppendix?.(id);
        const focusedContext = trusted.focusedContext?.(id);
        if (focusedContext && !agentMapIdentity)
          throw new TypeError("Focused project context requires a project-agent identity");
        const sessionStartSystemMessage =
          trusted.sessionStartSystemMessage?.(id);
        const launchContext =
          promptAppendix || focusedContext || sessionStartSystemMessage || agentMapIdentity
            ? {
                ...(promptAppendix ? { promptAppendix } : {}),
                ...(focusedContext ? { focusedContext } : {}),
                ...(sessionStartSystemMessage
                  ? { sessionStartSystemMessage }
                  : {}),
                ...(agentMapIdentity ? { agentMapIdentity } : {}),
              }
            : undefined;
        opts = {
          harnessSessionId: id,
          cwd: req.cwd,
          ...(req.initialPrompt ? { initialPrompt: req.initialPrompt } : {}),
          ...(await (launchContext
            ? this.buildLaunchOpts(id, req, launchContext)
            : this.buildLaunchOpts(id, req))),
        };
        spec = adapter.launch(opts);
      } catch (error) {
        // Scope resolution may already have claimed bootstrap ownership, and
        // launch preparation may already have issued a capability. Revoke both
        // for every setup failure, including prompt composition/config writes,
        // while preserving the original actionable error.
        await Promise.resolve(this.onAgentMapSessionExit?.(id)).catch(() => {});
        throw error;
      }
      const projectBootstrap = preparedProjectSession?.projectBootstrap;
      const session: HarnessSession = {
        id,
        agentSessionId: null,
        harness: req.harness,
        cwd: req.cwd,
        title:
          trusted.initialTitle ??
          preparedProjectSession?.initialTitle ??
          (basename(req.cwd) || req.cwd),
        status: "starting",
        createdAt: this.now(),
        lastActiveAt: this.now(),
        exitCode: null,
        boundWorkflowPath: null,
        // Ordinary callers record only what the builder actually rehydrated.
        // A trusted planner replacement records its exact FIFO predecessor even
        // when the brief came from an older recorded ancestor in that chain.
        rehydratedFrom:
          trusted.handoffFromSessionId ?? opts.rehydratedFrom ?? null,
        // Persisted so resume() regenerates the same ANSI base — otherwise a
        // resumed session would fall back to the server default and its dim text
        // could lose contrast against a differently-themed terminal.
        ...(req.theme ? { theme: req.theme } : {}),
        ready: false,
        ...(projectBootstrap
          ? { projectBootstrap: structuredClone(projectBootstrap) }
          : {}),
        ...(agentMapIdentity
          ? { agentMapIdentity: structuredClone(agentMapIdentity) }
          : {}),
      };
      this.sessions.set(id, session);
      try {
        await this.persist();
        // Before spawning, not fire-and-forget: the agent's very first read of
        // HARNESS_CONTEXT_FILE must never race session creation with an ENOENT,
        // regardless of which entry point called create() (REST, autoCreateSession).
        await this.writeWorkspaceContext(session);
        // Same reasoning: the canvas pane opens immediately once the session is
        // "running" — it must never show a bare empty iframe because nothing's
        // been written to .sapiom/canvas/index.html yet.
        await this.ensureCanvasTemplate(session.cwd);
        await this.spawn(session, spec, () =>
          this.revalidateAgentMapIdentity(
            session.id,
            session.cwd,
            agentMapIdentity,
          ),
        );
        if (session.projectBootstrap) {
          const runtimeEpoch = this.getRuntimeEpoch(session.id);
          if (runtimeEpoch === null) throw new Error("session runtime unavailable");
          await Promise.resolve(
            this.onProjectBootstrapSession?.(session, "created", runtimeEpoch),
          ).catch(() => {});
        }
      } catch (err) {
        // The first persist may itself be the failure, so reconciliation is
        // best-effort: always repair the in-memory record to "exited", attempt
        // the durable repair, and preserve the original actionable failure if
        // that second write also fails.
        await this.transitionExited(session, null).catch(() => {});
        throw err;
      }
      return session;
    };
    try {
      return await (agentMapIdentity
        ? this.serializeProjectCreate(agentMapIdentity.projectId, createResolved)
        : createResolved());
    } finally {
      this.pendingCreates.delete(id);
    }
  }

  /**
   * Narrow recovery for an exact coordinator-owned row that exited before its
   * first turn and has no resumable vendor conversation. The Harness ID stays
   * fixed; the private marker advances before a fresh PTY can be admitted.
   */
  async restartFreshBound(
    id: string,
    expected: TrustedSubsessionBindingMarker,
    nextInput: TrustedSubsessionBindingMarker,
    trusted: TrustedSessionCreateOptions,
    hasRecordedTurns: (sessionId: string) => Promise<boolean>,
  ): Promise<HarnessSession> {
    if (this.closing) throw new SessionManagerClosingError();
    const currentExpected = parseTrustedSubsessionBindingMarker(expected, id);
    const next = parseTrustedSubsessionBindingMarker(nextInput, id);
    const current = this.subsessionBindings.get(id);
    const session = this.sessions.get(id);
    if (
      !currentExpected ||
      !next ||
      !current ||
      !session ||
      (current.projectId !== currentExpected.projectId ||
        current.parentSessionId !== currentExpected.parentSessionId ||
        current.bindingId !== currentExpected.bindingId ||
        current.sessionId !== currentExpected.sessionId) ||
      next.projectId !== currentExpected.projectId ||
      next.parentSessionId !== currentExpected.parentSessionId ||
      next.bindingId !== currentExpected.bindingId ||
      next.sessionId !== currentExpected.sessionId ||
      next.incarnation !== currentExpected.incarnation + 1 ||
      next.spawnEpoch <= currentExpected.spawnEpoch ||
      this.ptys.has(id) ||
      session.status !== "exited"
    ) {
      throw new SubsessionBindingMismatchError();
    }
    if (this.userClosedSubsessions.has(id))
      throw new SubsessionFreshRestartForbiddenError();
    // A retry may observe the already-advanced marker after the sidecar write
    // committed but before the fresh process existed.
    if (
      !sameSubsessionBinding(current, currentExpected) &&
      !sameSubsessionBinding(current, next)
    ) {
      throw new SubsessionBindingMismatchError();
    }
    const adapter = this.getAdapter(session.harness);
    if (
      (session.agentSessionId !== null &&
        (await adapter.canResume(session.agentSessionId, session.cwd))) ||
      (await hasRecordedTurns(id))
    ) {
      throw new SubsessionFreshRestartForbiddenError();
    }

    if (!sameSubsessionBinding(current, next)) {
      this.subsessionBindings.set(id, next);
      try {
        await this.persistSubsessionBindings();
      } catch (error) {
        this.subsessionBindings.set(id, current);
        throw error;
      }
    }

    const trustedIdentity = trusted.agentMapIdentity?.(id);
    const agentMapIdentity = this.resolveAgentMapIdentity
      ? await this.resolveAgentMapIdentity(id, session.cwd, trustedIdentity)
      : trustedIdentity;
    if (
      !agentMapIdentity ||
      agentMapIdentity.projectId !== next.projectId ||
      agentMapIdentity.sessionId !== id
    ) {
      throw new ProjectSessionScopeUnavailableError(id);
    }

    const lastActiveBeforeRestart = session.lastActiveAt;
    session.status = "starting";
    session.exitCode = null;
    session.exitTail = null;
    session.agentSessionId = null;
    session.agentMapIdentity = structuredClone(agentMapIdentity);
    session.lastActiveAt = this.now();
    let spec: SpawnSpec;
    try {
      const promptAppendix = trusted.promptAppendix?.(id);
      const focusedContext = trusted.focusedContext?.(id);
      const sessionStartSystemMessage =
        trusted.sessionStartSystemMessage?.(id);
      const context = {
        ...(promptAppendix ? { promptAppendix } : {}),
        ...(focusedContext ? { focusedContext } : {}),
        ...(sessionStartSystemMessage
          ? { sessionStartSystemMessage }
          : {}),
        agentMapIdentity,
      };
      const opts: LaunchOpts = {
        harnessSessionId: id,
        cwd: session.cwd,
        ...(await this.buildLaunchOpts(id, session, context)),
      };
      spec = adapter.launch(opts);
    } catch (error) {
      session.status = "exited";
      session.lastActiveAt = lastActiveBeforeRestart;
      await Promise.resolve(this.onAgentMapSessionExit?.(id)).catch(() => {});
      throw error;
    }
    try {
      await this.persist();
      this.emitStatus(session);
      await this.writeWorkspaceContext(session);
      await this.ensureCanvasTemplate(session.cwd);
      await this.spawn(session, spec, () =>
        this.revalidateAgentMapIdentity(id, session.cwd, agentMapIdentity),
      );
      return session;
    } catch (error) {
      session.lastActiveAt = lastActiveBeforeRestart;
      await this.transitionExited(session, null, {
        stampLastActive: false,
      }).catch(() => {});
      throw error;
    }
  }
}



/** An automatic first-session create lost the project bootstrap claim. */
export class ProjectBootstrapClaimUnavailableError extends Error {
  readonly code = "PROJECT_BOOTSTRAP_CLAIM_UNAVAILABLE";

  constructor() {
    super("the project bootstrap claim is already owned by another session");
    this.name = "ProjectBootstrapClaimUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
