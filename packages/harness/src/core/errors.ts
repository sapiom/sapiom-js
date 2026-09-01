/**
 * Typed errors for session and spawn failures. Each carries a stable `code`
 * so callers can react programmatically to specific failure modes instead of
 * parsing error message strings.
 *
 * HTTP mappings (server/rest.ts, server/macros.ts):
 *   UnknownSessionError       → 404
 *   SessionNotReadyError      → 409
 *   SessionAlreadyLiveError   → 409
 *   SessionNotResumeableError → 409
 *   AgentSessionIdentityReservedError → 409
 *   AdapterNotFoundError      → 400
 *   SpawnTargetError          → 400
 *   ExternalHarnessError      → 409
 */

/** Base class for all typed harness errors. */
export class HarnessError extends Error {
  /** Stable machine-readable code callers can branch on without parsing messages. */
  readonly code: string;
  /** Underlying error, when this error wraps another. */
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    // Ensure instanceof checks survive transpilation to ES5-style output.
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an operation references a session id that does not exist in the
 * registry. Maps to HTTP 404.
 */
export class UnknownSessionError extends HarnessError {
  constructor(id: string) {
    super("UNKNOWN_SESSION", `Unknown session "${id}"`);
  }
}

/**
 * Thrown by `submitInput()` when a session's pty is alive but never became
 * interactive within the grace period — the trust-dialog race this readiness
 * mechanism exists to catch. Maps to HTTP 409.
 */
export class SessionNotReadyError extends HarnessError {
  constructor(id: string) {
    super(
      "SESSION_NOT_READY",
      `Session "${id}" is not ready yet — check the terminal, it may be asking to trust the folder.`,
    );
  }
}

/**
 * Thrown by `resume()` when the session cannot be handed back to its agent.
 * Two causes, both 409:
 *
 *  1. No `agentSessionId` at all — never fully started (the default message).
 *  2. An `agentSessionId` the agent's own store no longer holds, caught by
 *     `resume()`'s `canResume` pre-flight. Pass `reason` for these: the
 *     message reaches the user as a toast, and "why" is the whole point —
 *     the old behaviour spawned a doomed pty and left them with a bare
 *     "exit code 1" and a Resume button that would fail again.
 */
export class SessionNotResumeableError extends HarnessError {
  constructor(id: string, reason?: string) {
    super("SESSION_NOT_RESUMEABLE", reason ?? `Session "${id}" has no agentSessionId to resume from`);
  }
}

/**
 * Thrown by `resume()` when the session already has a live pty — double-resume
 * is a no-op caller error. Maps to HTTP 409.
 */
export class SessionAlreadyLiveError extends HarnessError {
  constructor(id: string) {
    super("SESSION_ALREADY_LIVE", `Session "${id}" already has a live pty`);
  }
}

/**
 * Thrown when generic adoption tries to claim a vendor conversation identity
 * that this installation has already assigned to a different registry row or
 * retained as a historical rotation tombstone. Maps to HTTP 409.
 */
export class AgentSessionIdentityReservedError extends HarnessError {
  constructor() {
    super(
      "AGENT_SESSION_IDENTITY_RESERVED",
      "This conversation identity is already owned by a local session",
    );
  }
}

/**
 * Thrown when an operation requires a harness adapter that has not been
 * registered. Maps to HTTP 400.
 */
export class AdapterNotFoundError extends HarnessError {
  constructor(harness: string) {
    super("ADAPTER_NOT_FOUND", `No adapter registered for harness "${harness}"`);
  }
}

/**
 * Thrown by `resolveSpawnTarget` (core/spawn-target.ts) when a command cannot
 * be turned into something `CreateProcess` can execute on Windows — not on
 * PATH, an unparseable `.cmd`/`.bat` shim, or a shim whose target is missing.
 * Every case is user-actionable ("install X", "restart to repair"), so it maps
 * to HTTP 400 and the message is shown verbatim in the UI.
 */
export class SpawnTargetError extends HarnessError {
  constructor(message: string) {
    super("SPAWN_TARGET", message);
  }
}

/**
 * Thrown when a spawn or send operation is attempted on an external-mode
 * harness adapter (e.g. Conductor) whose sessions are managed by its own
 * companion app — the harness cannot spawn or inject into them. Maps to
 * HTTP 409.
 *
 * The `harness` field names the adapter so the UI can show a targeted message
 * (e.g. "Conductor sessions are managed by the Conductor app").
 */
export class ExternalHarnessError extends HarnessError {
  readonly harness: string;

  constructor(harness: string, label: string) {
    super(
      "HARNESS_EXTERNAL",
      `${label} sessions are managed by the ${label} app — spawn and send are not available.`,
    );
    this.harness = harness;
  }
}
