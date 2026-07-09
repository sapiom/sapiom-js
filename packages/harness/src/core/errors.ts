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
 *   AdapterNotFoundError      → 400
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
 * Thrown by `resume()` when the session record has no `agentSessionId` to
 * resume from (it was never fully started, or is history-only with no
 * recorded session). Maps to HTTP 409.
 */
export class SessionNotResumeableError extends HarnessError {
  constructor(id: string) {
    super("SESSION_NOT_RESUMEABLE", `Session "${id}" has no agentSessionId to resume from`);
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
 * Thrown when an operation requires a harness adapter that has not been
 * registered. Maps to HTTP 400.
 */
export class AdapterNotFoundError extends HarnessError {
  constructor(harness: string) {
    super("ADAPTER_NOT_FOUND", `No adapter registered for harness "${harness}"`);
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
