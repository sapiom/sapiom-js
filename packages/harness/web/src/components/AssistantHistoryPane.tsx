import { useEffect, useState, type ReactNode } from "react";
import type { AssistantHistoryEntry } from "../../../src/shared/assistant-history";
import {
  readAssistantRecord,
  type ReadableAssistantRecord,
} from "../lib/assistant-history-client";
import { formatClockTime } from "../lib/session-record-view";
import { Markdown } from "./Markdown";

const limitations: Record<string, string> = {
  "private-parts-omitted":
    "Private reasoning and instructions are not included.",
  "unknown-parts": "Some content could not be reconstructed.",
  "attachment-content-omitted":
    "Attachment contents are not saved in this record.",
  "accepted-context-unavailable":
    "Some workspace context is missing from this record.",
  "field-truncation": "Long messages or tool results were shortened.",
  "dropped-early-turns": "Only the most recent turns fit in this saved record.",
  "dropped-message-content":
    "Some message content was omitted to keep the record bounded.",
};

/** Read-only recorded material. Mounting this pane never starts a runtime. */
export function AssistantHistoryPane({
  entry,
  bootToken,
  onClose,
  actions,
  onOpenTerminal,
  terminalLabel,
  terminalNotStarted,
}: {
  entry: AssistantHistoryEntry;
  bootToken: string;
  onClose: () => void;
  actions?: (
    record: ReadableAssistantRecord | null,
    refresh: () => void,
  ) => ReactNode;
  onOpenTerminal?: () => void;
  terminalLabel?: string;
  terminalNotStarted?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    loading: boolean;
    record: ReadableAssistantRecord | null;
    failed: boolean;
  }>({ loading: true, record: null, failed: false });
  useEffect(() => {
    const abort = new AbortController();
    setState({ loading: true, record: null, failed: false });
    void readAssistantRecord(entry, bootToken, abort.signal)
      .then((record) => {
        if (!abort.signal.aborted)
          setState({ loading: false, record, failed: false });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setState({ loading: false, record: null, failed: true });
      });
    return () => abort.abort();
  }, [entry, bootToken, attempt]);
  return (
    <div
      className="past-session-pane"
      data-testid="assistant-history-pane"
      data-session-id={entry.harnessSessionId}
    >
      <header className="past-session-header">
        <div className="past-session-heading">
          <div className="dead-session-title">{entry.title}</div>
          <div className="dead-session-meta">
            Assistant history · {entry.cwd}
          </div>
        </div>
        <div className="dead-session-actions">
          {onOpenTerminal && (
            <button className="btn-ghost" onClick={onOpenTerminal}>
              {terminalLabel ?? "View Terminal history"}
            </button>
          )}
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      {terminalNotStarted && (
        <p className="dead-session-resume-reason">
          Terminal has not started for this session.
        </p>
      )}
      <div className="past-session-body">
        {actions?.(state.record, () => setAttempt((value) => value + 1))}
        {state.loading ? (
          <div className="past-session-status" role="status">
            Loading Assistant history…
          </div>
        ) : state.failed ? (
          <div className="past-session-status" role="alert">
            Assistant history is unavailable.{" "}
            <button
              className="btn-ghost"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        ) : !state.record ? (
          <div className="past-session-status">
            No Assistant conversation was recorded for this session.
          </div>
        ) : (
          <div className="transcript" data-testid="assistant-transcript">
            <div className="transcript-notice">
              <span className="transcript-badge">Reconstructed</span>
              <div className="transcript-notice-body">
                <p className="transcript-notice-lead">
                  Saved Assistant messages and tool results from{" "}
                  {formatClockTime(state.record.capturedAt)}. This record may be
                  incomplete and does not restore the original conversation
                  context.
                </p>
                {state.record.limitations.length > 0 && (
                  <ul className="transcript-notice-list">
                    {state.record.limitations.map((code) => (
                      <li key={code}>
                        {limitations[code] ??
                          "Some recorded content is unavailable."}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <ol className="transcript-turns">
              {state.record.turns.map((turn) => (
                <li className="transcript-turn" key={turn.id}>
                  {turn.messages.map((message) => (
                    <section key={message.id}>
                      <div className="transcript-role">
                        <span className="transcript-role-label">
                          {message.role === "user" ? "You" : "Assistant"}
                        </span>
                      </div>
                      {message.parts.map((part) =>
                        part.type === "text" ? (
                          <div className="transcript-assistant" key={part.id}>
                            <Markdown text={part.text} />
                            {part.truncated && (
                              <span className="transcript-absent">
                                Recorded text was shortened.
                              </span>
                            )}
                          </div>
                        ) : part.type === "tool" ? (
                          <details className="transcript-tool" key={part.id}>
                            <summary className="transcript-tool-summary">
                              {part.name} · {part.status} when recorded
                              {part.truncated ? " · shortened" : ""}
                            </summary>
                            <div className="transcript-tool-body">
                              <div className="transcript-tool-heading">
                                Input
                              </div>
                              <pre className="transcript-tool-pre">
                                {part.input}
                              </pre>
                              <div className="transcript-tool-heading">
                                Recorded result
                              </div>
                              <pre className="transcript-tool-pre">
                                {part.output ??
                                  part.error ??
                                  "No result recorded."}
                              </pre>
                            </div>
                          </details>
                        ) : (
                          <p className="transcript-absent" key={part.id}>
                            {part.type === "file"
                              ? `Attachment: ${part.name ?? part.mime} (contents not saved)`
                              : "Some content was omitted."}
                          </p>
                        ),
                      )}
                    </section>
                  ))}
                  {turn.incomplete && (
                    <div className="transcript-incomplete">
                      Turn incomplete when recorded
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
