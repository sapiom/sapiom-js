/**
 * Execution detection — mirrors {@link PortDetector} (core/port-detector.ts).
 *
 * When the coding agent runs `sapiom agents run`, the CLI prints
 * `✓ Started execution <executionId>`. This detector is fed the SAME tool.call
 * output PortDetector is (server/index.ts `onNormalizedEvent`) and fires
 * `onExecution` once per distinct (session, executionId) it finds — so the SPA
 * can start polling that run's live state without changing how runs are
 * triggered. The integrator wires `onExecution` to broadcast
 * `{ type: "execution.started", … }` on /ws/events.
 *
 * Same streaming-safe design as PortDetector: a match touching the very end of
 * the buffered text is held back (the id may still be growing in the next
 * chunk) and finalized by `flush()`, which the integrator calls right after
 * feeding a discrete, already-complete string (one tool.call field).
 */

/** Execution ids are the stable handles the executions API mints (e.g.
 *  `exec_ab12…`). Id-safe characters only, so a trailing space, newline, or
 *  ANSI reset ends the match rather than being captured into the id. */
const EXECUTION_ID = String.raw`[A-Za-z0-9_-]+`;
const EXECUTION_PATTERN_SOURCE = String.raw`Started execution (${EXECUTION_ID})`;

/** Long enough to hold the literal "Started execution " anchor split across a
 *  chunk boundary, plus a few id characters either side. */
const TAIL_SAFETY = 48;

/**
 * Pure parser: every execution id announced in a chunk of CLI/tool output, in
 * order (empty when the chunk announces none). This is the mutation-tested
 * core — the {@link ExecutionDetector} class only adds streaming buffering and
 * per-session dedupe on top of it.
 */
export function parseExecutionIds(text: string): string[] {
  const regex = new RegExp(EXECUTION_PATTERN_SOURCE, "g");
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) ids.push(match[1]);
  return ids;
}

/** Where a detected run executes. Only `"prod"` is emitted today: the CLI's
 *  `Started execution` line is the prod-run announcement; local runs are
 *  rendered from their final result, not polled (see the design). */
export type ExecutionTarget = "prod" | "local";

export interface ExecutionDetectorDeps {
  onExecution(harnessSessionId: string, executionId: string, target: ExecutionTarget): void;
}

/**
 * Stateful, streaming-safe, and dedupes per (session, executionId) so a run id
 * that reappears in output only ever fires `onExecution` once for the session's
 * lifetime. `reset()` clears a session's state on exit so a reused session id
 * starts clean.
 */
export class ExecutionDetector {
  private readonly buffers = new Map<string, string>();
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly deps: ExecutionDetectorDeps) {}

  feed(chunk: string, harnessSessionId: string): void {
    const combined = (this.buffers.get(harnessSessionId) ?? "") + chunk;
    const regex = new RegExp(EXECUTION_PATTERN_SOURCE, "g");

    let match: RegExpExecArray | null;
    let pendingFrom: number | null = null;

    while ((match = regex.exec(combined))) {
      const end = match.index + match[0].length;
      if (end === combined.length) {
        // The id could still be growing (more chars due next chunk) — hold back.
        pendingFrom = match.index;
        break;
      }
      this.tryEmit(harnessSessionId, match[1]);
    }

    const retainFrom = pendingFrom ?? Math.max(0, combined.length - TAIL_SAFETY);
    this.buffers.set(harnessSessionId, combined.slice(retainFrom));
  }

  /**
   * Finalizes whatever's held back for a session, immediately. Call this right
   * after `feed()` whenever the fed text is a discrete, complete string (one
   * tool.call field): without it, an id landing at the very end — the common
   * shape "✓ Started execution exec_123" — would be held pending forever, since
   * no "next chunk" is coming.
   */
  flush(harnessSessionId: string): void {
    const pending = this.buffers.get(harnessSessionId);
    if (!pending) return;
    for (const id of parseExecutionIds(pending)) this.tryEmit(harnessSessionId, id);
    this.buffers.delete(harnessSessionId);
  }

  /** Drops buffered/dedupe state for a session — call on session exit so a
   *  reused session id starts clean. */
  reset(harnessSessionId: string): void {
    this.buffers.delete(harnessSessionId);
    this.seen.delete(harnessSessionId);
  }

  private tryEmit(harnessSessionId: string, executionId: string): void {
    let ids = this.seen.get(harnessSessionId);
    if (!ids) {
      ids = new Set();
      this.seen.set(harnessSessionId, ids);
    }
    if (ids.has(executionId)) return;
    ids.add(executionId);
    this.deps.onExecution(harnessSessionId, executionId, "prod");
  }
}
