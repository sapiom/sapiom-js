/**
 * Typed errors thrown by the session runtime. Each carries a stable `code`
 * so callers (e.g. a future `doctor` command) can react programmatically
 * instead of parsing messages.
 */

/** Base class for all typed `@sapiom/harness` errors. */
export class HarnessError extends Error {
  /** Underlying error, when this error wraps one. */
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
    // Keep instanceof working when the target is ES5-ish output.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Remediation shown when node-pty cannot be loaded (usually because its
 * native addon was never built, was built for a different Node version, or
 * the package manager skipped its build script).
 */
export const PTY_UNAVAILABLE_REMEDIATION = [
  "node-pty could not be loaded, so pty sessions are unavailable.",
  "Likely causes: the native addon was not built during install, or it was",
  "built for a different Node.js version. Try reinstalling dependencies",
  "(`pnpm install`) or rebuilding the addon (`pnpm rebuild node-pty`).",
  "With pnpm 10+, make sure node-pty is allowed to run its build scripts",
  "(`pnpm approve-builds`). Build prerequisites are listed at",
  "https://github.com/microsoft/node-pty#dependencies",
].join(" ");

/**
 * Thrown by `PtyRuntime.create()` when the node-pty native module cannot be
 * imported. Surfaced at create-time (node-pty is imported lazily) so simply
 * loading this package never crashes on machines without a working build.
 */
export class PtyUnavailableError extends HarnessError {
  readonly code = "PTY_UNAVAILABLE";
  /** Human-readable hint on how to fix the environment. */
  readonly remediation = PTY_UNAVAILABLE_REMEDIATION;

  constructor(cause?: unknown) {
    const detail =
      cause instanceof Error
        ? ` (${cause.message})`
        : cause
          ? ` (${String(cause)})`
          : "";
    super(
      `Failed to load node-pty${detail}. ${PTY_UNAVAILABLE_REMEDIATION}`,
      cause,
    );
  }
}

/** Thrown when a handle does not belong to (or was never created by) a runtime. */
export class UnknownSessionError extends HarnessError {
  readonly code = "UNKNOWN_SESSION";

  constructor(sessionId: string) {
    super(`Unknown session: ${sessionId}`);
  }
}
