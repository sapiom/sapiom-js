/**
 * Per-harnessSessionId monotonic sequence counter for AnalyticsEvent.seq.
 * Assigned server-side (in the ingest path), never by the hook script —
 * emit.cjs invocations race across concurrent hooks and can't be trusted
 * to self-order.
 */

export interface SeqCounter {
  /** Returns 1 on first call for a given harnessSessionId, incrementing from there. */
  next(harnessSessionId: string): number;
  /** Drop the counter for a session (e.g. once it's known to have ended). */
  reset(harnessSessionId: string): void;
}

export function createSeqCounter(): SeqCounter {
  const counters = new Map<string, number>();
  return {
    next(harnessSessionId: string): number {
      const value = (counters.get(harnessSessionId) ?? 0) + 1;
      counters.set(harnessSessionId, value);
      return value;
    },
    reset(harnessSessionId: string): void {
      counters.delete(harnessSessionId);
    },
  };
}
