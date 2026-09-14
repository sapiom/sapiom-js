import { useEffect, useRef, useState } from "react";
import type { AssistantHistoryEntry } from "../../../src/shared/assistant-history";
import type { AssistantLifecycle } from "../../../src/shared/assistant-session";
import { inspectAssistant } from "../lib/assistant-resume-client";

export function AssistantHistoryActions({
  entry,
  lifecycle,
  bootToken,
  operations,
  onResume,
}: {
  entry: AssistantHistoryEntry;
  lifecycle?: AssistantLifecycle;
  bootToken: string;
  operations: Map<string, string>;
  onResume: (
    entry: AssistantHistoryEntry,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
}) {
  const current =
    lifecycle && lifecycle.revision >= entry.lifecycle.revision
      ? { ...entry, lifecycle }
      : entry;
  const [inspected, setInspected] = useState<AssistantHistoryEntry | null>(
    null,
  );
  const [busy, setBusy] = useState<"inspect" | "resume" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const observedRevision = useRef(current.lifecycle.revision);
  useEffect(() => {
    setInspected(null);
    setFailure(null);
    setBusy(null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [entry.harnessSessionId, bootToken, operations]);
  useEffect(() => {
    // Resume publishes its own committed revision before its HTTP response.
    // Let the hook compare that result with current bus truth before resetting.
    if (
      observedRevision.current === current.lifecycle.revision ||
      busy === "resume"
    )
      return;
    operations.delete(`${entry.harnessSessionId}:${observedRevision.current}`);
    observedRevision.current = current.lifecycle.revision;
    request.current?.abort();
    request.current = null;
    setInspected(null);
    setFailure(null);
    setBusy(null);
  }, [entry.harnessSessionId, current.lifecycle.revision, busy, operations]);
  const run = async (action: "inspect" | "resume") => {
    if (request.current) return;
    const abort = new AbortController();
    request.current = abort;
    setBusy(action);
    setFailure(null);
    try {
      if (action === "inspect") {
        const next = await inspectAssistant(current, bootToken, abort.signal);
        if (!abort.signal.aborted) setInspected(next);
      } else if (inspected?.nativeResume === "available") {
        const key = `${entry.harnessSessionId}:${inspected.lifecycle.revision}`;
        const operationId = operations.get(key) ?? crypto.randomUUID();
        operations.set(key, operationId);
        const opened = await onResume(inspected, operationId, abort.signal);
        if (!abort.signal.aborted && opened) operations.delete(key);
        else if (!abort.signal.aborted)
          setFailure("This session changed. Check Resume availability again.");
      }
    } catch (error) {
      if (!abort.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : "Assistant is unavailable. Check again.",
        );
    } finally {
      if (request.current === abort) {
        request.current = null;
        setBusy(null);
      }
    }
  };
  const available = inspected?.nativeResume === "available";
  return (
    <div data-testid="assistant-history-actions">
      {current.lifecycle.lifecycle === "ending" ? (
        <p role="status">
          Session cleanup is incomplete. Retry End before resuming Assistant.
        </p>
      ) : (
        <>
          <button
            className={available ? "btn-primary" : "btn-ghost"}
            disabled={busy !== null}
            onClick={() => void run(available ? "resume" : "inspect")}
          >
            {busy === "inspect"
              ? "Checking Resume availability…"
              : busy === "resume"
                ? "Resuming Assistant…"
                : available
                  ? "Resume Assistant"
                  : "Check Resume availability"}
          </button>
          {available && (
            <p className="dead-session-resume-reason">
              Restores the same conversation. Restarted Assistant stays paused
              until you send a message.
            </p>
          )}
          {inspected && !available && (
            <p className="dead-session-resume-reason" role="status">
              {inspected.resumeFailure?.message ??
                "The original Assistant conversation is unavailable."}{" "}
              Your saved record remains readable; it may contain only part of
              the original context.
            </p>
          )}
        </>
      )}
      {failure && (
        <p className="dead-session-resume-reason" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
