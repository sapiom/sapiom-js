/**
 * Fetches a past session's reconstructed transcript for whichever pane is
 * showing it — the review pane for a history row, the dead-session pane for a
 * session the registry still tracks. Both need the same four states, so the
 * fetch lives here instead of being written twice.
 *
 * `loadRecord` must be referentially stable (it's an effect dependency) — the
 * harness state hook memoizes it for exactly this reason. A record that comes
 * back null is `empty`, not an error: plenty of history rows are sessions the
 * Studio never ran, or whose events have aged out of the local log.
 */
import { useEffect, useState } from "react";
import type { SessionRecord } from "@shared/types";

export type SessionRecordState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; record: SessionRecord };

export function useSessionRecord(
  recordId: string | null,
  loadRecord: (id: string) => Promise<SessionRecord | null>,
): SessionRecordState {
  const [state, setState] = useState<SessionRecordState>(
    recordId === null ? { status: "empty" } : { status: "loading" },
  );

  useEffect(() => {
    if (recordId === null) {
      setState({ status: "empty" });
      return;
    }
    // Guards against a late response for a session the user already left —
    // switching rows quickly would otherwise render the wrong transcript.
    let cancelled = false;
    setState({ status: "loading" });
    loadRecord(recordId).then(
      (record) => {
        if (cancelled) return;
        setState(record ? { status: "ready", record } : { status: "empty" });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [recordId, loadRecord]);

  return state;
}
