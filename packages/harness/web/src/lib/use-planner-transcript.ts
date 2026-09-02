import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRecord } from "@shared/types";

import type { SessionRecordState } from "./use-session-record";

type RecordResult =
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; record: SessionRecord };

/**
 * Coalesces content-free record invalidations without dropping the one that
 * arrives while a read is already in flight. That trailing read matters for a
 * normal turn: `prompt.submitted` and `turn.completed` can be persisted close
 * enough together that the first snapshot does not yet contain the reply.
 */
export class CoalescedSessionRecordReader {
  private reading = false;
  private trailing = false;
  private disposed = false;

  constructor(
    private readonly recordId: string,
    private readonly loadRecord: (id: string) => Promise<SessionRecord | null>,
    private readonly apply: (result: RecordResult) => void,
  ) {}

  refresh(): void {
    if (this.disposed) return;
    if (this.reading) {
      this.trailing = true;
      return;
    }
    this.reading = true;
    void this.readLoop();
  }

  dispose(): void {
    this.disposed = true;
    this.trailing = false;
  }

  private async readLoop(): Promise<void> {
    do {
      this.trailing = false;
      try {
        const record = await this.loadRecord(this.recordId);
        if (!this.disposed) {
          this.apply(
            record ? { status: "ready", record } : { status: "empty" },
          );
        }
      } catch (error) {
        if (!this.disposed) {
          this.apply({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } while (this.trailing && !this.disposed);
    this.reading = false;
  }
}

/** Live planner transcript backed by the existing SessionRecord endpoint. */
export function usePlannerTranscript(
  sessionId: string | null,
  revision: number,
  loadRecord: (id: string) => Promise<SessionRecord | null>,
): { state: SessionRecordState; retry: () => void } {
  const [state, setState] = useState<SessionRecordState>(
    sessionId === null ? { status: "empty" } : { status: "loading" },
  );
  const readerRef = useRef<CoalescedSessionRecordReader | null>(null);
  const observedRevisionRef = useRef(revision);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

  useEffect(() => {
    readerRef.current?.dispose();
    observedRevisionRef.current = revisionRef.current;
    if (sessionId === null) {
      readerRef.current = null;
      setState({ status: "empty" });
      return;
    }
    setState({ status: "loading" });
    const reader = new CoalescedSessionRecordReader(
      sessionId,
      loadRecord,
      setState,
    );
    readerRef.current = reader;
    reader.refresh();
    return () => reader.dispose();
  }, [loadRecord, sessionId]);

  useEffect(() => {
    if (revision === observedRevisionRef.current) return;
    observedRevisionRef.current = revision;
    readerRef.current?.refresh();
  }, [revision, sessionId]);

  const retry = useCallback((): void => {
    if (!readerRef.current) return;
    setState({ status: "loading" });
    readerRef.current.refresh();
  }, []);

  return { state, retry };
}
