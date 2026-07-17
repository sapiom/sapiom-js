/**
 * Transport-agnostic poll controller for live run state.
 *
 * The controller fetches a RunView on a fixed cadence and stops when the run
 * reaches a terminal status. The `fetchRunState` dependency is the only seam
 * that couples this to HTTP — swapping it for a WebSocket push source requires
 * no change to the controller's public API or the hook that consumes it.
 */
import type { RunView } from "@shared/types";

export interface RunPollDeps {
  fetchRunState: (executionId: string, signal: AbortSignal) => Promise<RunView>;
  onUpdate: (executionId: string, runView: RunView) => void;
  /** Interval between fetches in milliseconds. Default 2000. */
  pollMs?: number;
}

export interface RunPollController {
  /** Start polling for `executionId`. Idempotent: a second call for the same
   *  id is a no-op (the existing interval keeps running). */
  start(executionId: string): void;
  /** Stop polling for `executionId` and abort any in-flight fetch for it. */
  stop(executionId: string): void;
  /** Stop and abort everything. */
  stopAll(): void;
  /** `true` → skip issuing new fetches on each tick (leaves intervals running
   *  and does NOT abort in-flight requests). `false` → resume. */
  setPaused(paused: boolean): void;
}

/** Consecutive failed fetches (non-2xx / network / mangled id) after which an
 *  id stops polling — so a bad or truncated id can't 404 forever. Set above the
 *  brief enqueued→queryable window (a real run becomes queryable within a poll
 *  or two), so a genuine run is never dropped. */
const MAX_CONSECUTIVE_FAILURES = 5;

interface PerIdState {
  intervalId: ReturnType<typeof setInterval>;
  inFlight: AbortController | null;
  failures: number;
}

export function createRunPollController(deps: RunPollDeps): RunPollController {
  const { fetchRunState, onUpdate, pollMs = 2000 } = deps;

  const tracked = new Map<string, PerIdState>();
  let paused = false;

  async function poll(executionId: string): Promise<void> {
    if (paused) return;

    const entry = tracked.get(executionId);
    if (!entry) return;

    // Skip if a fetch for this id is still in flight — no overlap.
    if (entry.inFlight !== null) return;

    const ac = new AbortController();
    entry.inFlight = ac;

    try {
      const runView = await fetchRunState(executionId, ac.signal);
      // Clear in-flight marker before acting on the result so that `stop`
      // called inside `onUpdate` or on terminal detection sees a clean state.
      const still = tracked.get(executionId);
      if (still) {
        still.inFlight = null;
        still.failures = 0; // a good read clears the failure streak
      }

      onUpdate(executionId, runView);

      if (runView.status !== "running") {
        stop(executionId);
      }
    } catch {
      // Aborts (from stop/stopAll) and transient errors both land here. Clear
      // the in-flight marker and count the failure; after too many in a row we
      // give up on this id so a bad/truncated id can't poll forever. (An abort
      // from stop() already deleted the entry, so it never counts here.)
      const still = tracked.get(executionId);
      if (still) {
        still.inFlight = null;
        still.failures += 1;
        if (still.failures >= MAX_CONSECUTIVE_FAILURES) stop(executionId);
      }
    }
  }

  function start(executionId: string): void {
    if (tracked.has(executionId)) return; // idempotent

    const entry: PerIdState = {
      intervalId: setInterval(() => {
        void poll(executionId);
      }, pollMs),
      inFlight: null,
      failures: 0,
    };
    tracked.set(executionId, entry);

    // Immediate first fetch — no wait for the first interval tick.
    void poll(executionId);
  }

  function stop(executionId: string): void {
    const entry = tracked.get(executionId);
    if (!entry) return;

    clearInterval(entry.intervalId);
    entry.inFlight?.abort();
    tracked.delete(executionId);
  }

  function stopAll(): void {
    for (const id of [...tracked.keys()]) {
      stop(id);
    }
  }

  function setPaused(value: boolean): void {
    paused = value;
  }

  return { start, stop, stopAll, setPaused };
}
