import { useEffect, useRef, useState } from "react";
import type { AssistantHistoryEntry } from "../../../src/shared/assistant-history";
import type { ReadableAssistantRecord } from "../lib/assistant-history-client";
import { isAssistantLifecycleConflict } from "../lib/assistant-resume-client";
import {
  completeContinueRequest,
  prepareContinueRequest,
  savedContinueRequest,
  type ContinueRequest,
} from "../lib/assistant-continuation-client";

export function AssistantContinueAction({
  entry,
  record,
  onRefreshRecord,
  bootToken,
  onContinue,
}: {
  entry: AssistantHistoryEntry;
  record: ReadableAssistantRecord | null;
  onRefreshRecord: () => void;
  bootToken: string;
  onContinue: (
    entry: AssistantHistoryEntry,
    request: ContinueRequest,
    signal: AbortSignal,
  ) => Promise<boolean>;
}) {
  const recordRevision = record?.turns.length ? record.revision : null;
  const [saved, setSaved] = useState<ContinueRequest | null>(() => {
    try {
      return savedContinueRequest(entry);
    } catch {
      return null;
    }
  });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<{
    request: ContinueRequest;
    record: ReadableAssistantRecord | null;
    refreshRequested: boolean;
  } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setFailure(null);
    try {
      setSaved(savedContinueRequest(entry));
    } catch {
      setSaved(null);
    }
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [
    entry.harnessSessionId,
    entry.lifecycle.revision,
    bootToken,
    entry.continuationScope,
  ]);
  useEffect(
    () => setRejected(null),
    [entry.harnessSessionId, bootToken, entry.continuationScope],
  );
  const reviewed =
    rejected?.refreshRequested &&
    record &&
    record !== rejected.record &&
    recordRevision !== null;
  const run = async (startNew = false) => {
    if (pending.current) return;
    if (startNew && !reviewed) return;
    const replace = startNew ? rejected?.request : undefined;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setFailure(null);
    setRejected(null);
    let request: ContinueRequest | null = null;
    try {
      request = await prepareContinueRequest(entry, recordRevision, replace);
      if (abort.signal.aborted) return;
      setSaved(request);
      const opened = await onContinue(entry, request, abort.signal);
      if (!abort.signal.aborted && opened)
        completeContinueRequest(entry, request.operationId);
      else if (!abort.signal.aborted)
        setFailure(
          "Your selection or session changed. Return here to retry the saved continuation.",
        );
    } catch (error) {
      if (!abort.signal.aborted) {
        if (request && isAssistantLifecycleConflict(error))
          setRejected({
            request,
            record: record ?? null,
            refreshRequested: false,
          });
        setFailure(
          error instanceof Error
            ? error.message
            : "Continuation is unavailable. Your original history is still available.",
        );
      }
    } finally {
      if (pending.current === abort) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <div data-testid="assistant-continue-action">
      <button
        className="btn-ghost"
        disabled={
          !entry.continuationScope ||
          busy ||
          entry.lifecycle.lifecycle === "ending" ||
          (recordRevision === null && !saved)
        }
        onClick={() => void run()}
      >
        {busy
          ? "Preparing continuation…"
          : saved
            ? "Retry Continue"
            : "Continue in new Assistant"}
      </button>
      <p className="dead-session-resume-reason">
        {!entry.continuationScope
          ? "Continuation is unavailable for this workspace. Your saved history is still readable."
          : saved
            ? "Retry checks the same saved request and its frozen brief; it does not start a second conversation."
            : recordRevision === null
              ? "No readable Assistant record is available to carry forward."
              : "Creates a new conversation from a recorded brief. The brief may be incomplete; the new Assistant stays paused until you send a message."}
      </p>
      {rejected && onRefreshRecord && (
        <>
          <button
            className={reviewed ? "btn-primary" : "btn-ghost"}
            disabled={busy || entry.lifecycle.lifecycle === "ending"}
            onClick={() => {
              if (reviewed) void run(true);
              else {
                setRejected({
                  ...rejected,
                  record: record ?? null,
                  refreshRequested: true,
                });
                onRefreshRecord();
              }
            }}
          >
            {reviewed ? "Start a new continuation" : "Review latest record"}
          </button>
          <p className="dead-session-resume-reason">
            The previous continuation was rejected because the session changed.
            Review the latest saved record before starting a new continuation.
          </p>
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
