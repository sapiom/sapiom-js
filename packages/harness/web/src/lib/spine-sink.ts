/**
 * Spine sink (SAP-1804 spike) — the minimal SPA-side consumer of the
 * intelligence-spine `spine.*` bus frames.
 *
 * This is the "test sink" the spike streams into: a pure reducer that folds
 * each `spine.*` bus message into per-run state (executionId, status, the
 * ordered frames seen so far). It is deliberately framework-free so both the
 * unit test and the React hook ({@link useSpineSink}) share one fold, and it
 * carries NO rendering — the real Assistant conversation pane is SAP-1806.
 *
 * Non-spine messages return the SAME map reference, so a caller can cheaply
 * skip re-renders when a frame wasn't for the spine.
 */
import type { BusMessage, SpineFrame } from "@shared/types";

export type SpineRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "error";

/** Accumulated state for one spine run, keyed by its `spineRunId`. */
export interface SpineRunState {
  spineRunId: string;
  /** Known once the run is enqueued (`spine.started`); null before then. */
  executionId: string | null;
  status: SpineRunStatus;
  /** Every frame seen, in arrival order. */
  frames: SpineFrame[];
  /** Terminal error text, present only when `status === "error"`. */
  error?: string;
}

export type SpineSinkState = ReadonlyMap<string, SpineRunState>;

/** An empty sink — the initial state for {@link foldSpineMessage}. */
export function emptySpineSink(): SpineSinkState {
  return new Map();
}

/**
 * Fold one bus message into the sink. Returns the input map unchanged for any
 * non-`spine.*` message; otherwise returns a new map with the affected run's
 * state updated (never mutates the input).
 */
export function foldSpineMessage(
  state: SpineSinkState,
  message: BusMessage,
): SpineSinkState {
  switch (message.type) {
    case "spine.started": {
      const next = new Map(state);
      const prev = state.get(message.spineRunId);
      next.set(message.spineRunId, {
        spineRunId: message.spineRunId,
        executionId: message.executionId,
        status: "running",
        // Preserve any frames that somehow preceded `started` (defensive; the
        // route always emits `started` first).
        frames: prev?.frames ?? [],
      });
      return next;
    }
    case "spine.frame": {
      const next = new Map(state);
      const prev = state.get(message.spineRunId);
      next.set(message.spineRunId, {
        spineRunId: message.spineRunId,
        executionId: prev?.executionId ?? message.executionId,
        status: prev?.status ?? "running",
        frames: [...(prev?.frames ?? []), message.frame],
        ...(prev?.error !== undefined ? { error: prev.error } : {}),
      });
      return next;
    }
    case "spine.finished": {
      const next = new Map(state);
      const prev = state.get(message.spineRunId);
      next.set(message.spineRunId, {
        spineRunId: message.spineRunId,
        executionId: message.executionId,
        status: message.status,
        frames: prev?.frames ?? [],
      });
      return next;
    }
    case "spine.error": {
      const next = new Map(state);
      const prev = state.get(message.spineRunId);
      next.set(message.spineRunId, {
        spineRunId: message.spineRunId,
        executionId: prev?.executionId ?? null,
        status: "error",
        frames: prev?.frames ?? [],
        error: message.error,
      });
      return next;
    }
    default:
      // Not a spine frame — hand back the same reference untouched.
      return state;
  }
}

/** Convenience selector: every run in the sink, in insertion order. */
export function spineRuns(state: SpineSinkState): SpineRunState[] {
  return [...state.values()];
}
