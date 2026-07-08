/**
 * Session abstractions for the harness.
 *
 * A `SessionRuntime` owns interactive terminal sessions in which coding
 * agents run. The v1 implementation is `PtyRuntime` (node-pty); alternative
 * runtimes (e.g. tmux-backed) can implement the same contract.
 */

/**
 * Opaque reference to a session owned by the runtime that created it.
 * Handles stay valid after the underlying process exits (`isAlive` turns
 * false) so callers can keep them around without lifecycle bookkeeping.
 */
export interface SessionHandle {
  /** Unique id of the session within its runtime. */
  readonly id: string;
}

/** Options for {@link SessionRuntime.create}. */
export interface SessionCreateOptions {
  /** Executable to launch (absolute path or resolvable via `env.PATH`). */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Full environment for the child. Not merged with `process.env`. */
  env: Record<string, string>;
  /** Working directory for the child. */
  cwd: string;
  /** Initial terminal width in columns. */
  cols: number;
  /** Initial terminal height in rows. */
  rows: number;
}

/**
 * Owns the lifecycle of interactive terminal sessions.
 */
export interface SessionRuntime {
  /** Spawn a new session. */
  create(opts: SessionCreateOptions): Promise<SessionHandle>;

  /**
   * Write raw input to the session (the prompt-injection primitive).
   * Writes to a session that already exited are dropped.
   */
  write(h: SessionHandle, data: string): void;

  /**
   * Subscribe to session output. Returns an unsubscribe function.
   * Only output produced after subscribing is delivered.
   */
  onData(h: SessionHandle, cb: (chunk: Buffer) => void): () => void;

  /** Resize the session's terminal. No-op once the session exited. */
  resize(h: SessionHandle, cols: number, rows: number): void;

  /**
   * Terminate the session, gracefully first, forcefully if it does not
   * exit in time. Resolves once the process is gone. Idempotent.
   */
  kill(h: SessionHandle): Promise<void>;

  /** Whether the session's process is still running. */
  isAlive(h: SessionHandle): boolean;
}
