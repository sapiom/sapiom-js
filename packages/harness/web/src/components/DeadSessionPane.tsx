import type { JSX } from "react";
import type { HarnessSession, SessionSummary } from "@shared/types";

import { HARNESS_LABELS, formatDuration, formatRelativeTime, historyRowMeta } from "../lib/history-meta";
import { Icon } from "./Icon";

interface DeadSessionPaneProps {
  session: HarnessSession;
  onResume: () => void;
  onClose: () => void;
}

/**
 * Renders in the terminal slot instead of <Terminal> whenever the active
 * session has exited — a pty that's already gone has nothing to connect to,
 * so showing the terminal's own WS-error banner (and leaving the user with
 * no obvious way out) is the wrong default. Always offers a way forward.
 *
 * Context comes from the session record itself: title, agent,
 * duration, when it ended, exit code. The registry keeps no scrollback for
 * an exited pty, so there is no last-output tail to show — metadata is
 * everything the record truly has (honest absence, never a fabricated tail).
 *
 * Resume is only offered when the session has an agentSessionId — without
 * one the agent never established its own session, so there is nothing to
 * hand off to. The button is disabled with an explanation in that case so
 * the user isn't left clicking a button that silently does nothing.
 */
export function DeadSessionPane({ session, onResume, onClose }: DeadSessionPaneProps): JSX.Element {
  // A session that exited before the agent established its own session id has
  // nothing to resume against — the server will return SessionNotResumeableError.
  const canResume = session.agentSessionId != null;
  const duration = formatDuration(session.createdAt, session.lastActiveAt);

  return (
    <div className="dead-session-pane" data-testid="dead-session-pane">
      <span className="empty-state-icon" aria-hidden="true">
        <Icon name="SquareTerminal" size={18} />
      </span>
      <div className="dead-session-title">Session exited</div>
      <div className="dead-session-meta">
        {session.cwd}
        {session.exitCode != null && ` · exit code ${session.exitCode}`}
      </div>
      <dl className="dead-session-detail" data-testid="dead-session-detail">
        {session.title && (
          <div className="dead-session-detail-row">
            <dt>Session</dt>
            <dd>{session.title}</dd>
          </div>
        )}
        <div className="dead-session-detail-row">
          <dt>Agent</dt>
          <dd>{HARNESS_LABELS[session.harness]}</dd>
        </div>
        {duration && (
          <div className="dead-session-detail-row">
            <dt>Ran for</dt>
            <dd>{duration}</dd>
          </div>
        )}
        <div className="dead-session-detail-row">
          <dt>Ended</dt>
          <dd>{formatRelativeTime(session.lastActiveAt)}</dd>
        </div>
      </dl>
      <div className="dead-session-actions">
        <button
          className="btn-primary"
          data-testid="dead-session-resume"
          onClick={onResume}
          disabled={!canResume}
          title={canResume ? undefined : "This session can't be resumed. It exited before establishing a session id."}
        >
          Resume
        </button>
        <button className="btn-ghost" data-testid="dead-session-close" onClick={onClose}>
          Close
        </button>
      </div>
      {!canResume && (
        <div className="dead-session-resume-reason" data-testid="dead-session-resume-reason">
          This session can't be resumed. It exited before establishing a session id.
        </div>
      )}
    </div>
  );
}

/**
 * Review pane for a PAST session from the history list: clicking a
 * past-session row never silently spawns a live session anymore — it lands
 * here first, and resuming (or starting fresh) is the explicit action.
 *
 * `resumable` mirrors what resumeFromHistory will actually do: entries the
 * registry still tracks reattach to their session; transcript-only entries
 * the harness never tracked can only start a fresh session in the same
 * directory — the button says which, honestly, before the click.
 */
export function PastSessionPane({
  summary,
  resumable,
  onStart,
  onClose,
}: {
  summary: SessionSummary;
  resumable: boolean;
  onStart: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="dead-session-pane" data-testid="past-session-pane">
      <div className="dead-session-title">{summary.title}</div>
      <div className="dead-session-meta">
        {historyRowMeta(summary)} · {summary.cwd}
      </div>
      <div className="dead-session-actions">
        <button className="btn-primary" data-testid="past-session-start" onClick={onStart}>
          {resumable ? "Resume" : "New session here"}
        </button>
        <button className="btn-ghost" data-testid="past-session-close" onClick={onClose}>
          Close
        </button>
      </div>
      {!resumable && (
        <div className="dead-session-resume-reason" data-testid="past-session-reason">
          This entry comes from the agent's own transcript history; the Studio can't reattach to
          its process. Starting opens a fresh session in the same directory.
        </div>
      )}
    </div>
  );
}
