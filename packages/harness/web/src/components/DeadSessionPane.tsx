import type { JSX } from "react";
import type { HarnessSession, SessionResumeMode, SessionSummary } from "@shared/types";

import { HARNESS_LABELS, formatDuration, formatRelativeTime, historyRowMeta } from "../lib/history-meta";
import { Icon } from "./Icon";

interface DeadSessionPaneProps {
  session: HarnessSession;
  /**
   * Server-verified resumability for this session, from its history row.
   * Undefined while that lookup is still in flight — Resume stays available in
   * that window (the server's own pre-flight is the backstop and answers 409
   * with the reason), but a resolved `rehydrate` disables the button outright
   * rather than letting the user click a guaranteed failure.
   */
  resumeMode: SessionResumeMode | undefined;
  onResume: () => void;
  onClose: () => void;
}

/** Why a session can't be handed back, in the user's terms. Two distinct
 *  causes — never started vs. started but left no transcript — and conflating
 *  them is what made the old single message misleading for most rows. */
function resumeBlockedReason(session: HarnessSession): string {
  return session.agentSessionId == null
    ? "This session can't be resumed. It exited before establishing a session id."
    : `${HARNESS_LABELS[session.harness]} has no saved conversation for this session, so there's nothing to hand back. That happens when a session ends before its first prompt — the agent never writes a transcript for those. Start a new session in this directory instead.`;
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
 * Resume is offered only when the AGENT still holds the conversation, which is
 * a question about the agent's own store, not about whether we captured an
 * `agentSessionId` (we capture that from the SessionStart hook, long before
 * there's anything worth resuming). The button is disabled with the real
 * reason otherwise, so the user isn't left clicking a button whose only
 * possible outcome is `exit code 1` and this same pane again.
 */
export function DeadSessionPane({ session, resumeMode, onResume, onClose }: DeadSessionPaneProps): JSX.Element {
  const canResume = session.agentSessionId != null && resumeMode !== "rehydrate";
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
          title={canResume ? undefined : resumeBlockedReason(session)}
        >
          Resume
        </button>
        <button className="btn-ghost" data-testid="dead-session-close" onClick={onClose}>
          Close
        </button>
      </div>
      {!canResume && (
        <div className="dead-session-resume-reason" data-testid="dead-session-resume-reason">
          {resumeBlockedReason(session)}
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
 * The button says what will actually happen, before the click, from the
 * server-verified `summary.resumeMode`: `agent-resume` reattaches to the
 * agent's own conversation (whether the registry tracked the row or it gets
 * adopted out of transcript history), `rehydrate` can only open a fresh
 * session in the same directory — which it says, with the real reason.
 *
 * Note this is no longer "did the registry track it": a tracked row whose
 * transcript the agent never wrote is `rehydrate`, and an untracked row whose
 * transcript is really there is `agent-resume`. The old registry-membership
 * test got both of those backwards.
 */
export function PastSessionPane({
  summary,
  onStart,
  onClose,
}: {
  summary: SessionSummary;
  onStart: () => void;
  onClose: () => void;
}): JSX.Element {
  const resumable = summary.resumeMode === "agent-resume";
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
          {HARNESS_LABELS[summary.harness]} has no saved conversation for this session, so it can't
          be reattached — sessions that end before their first prompt are never written to the
          agent's history. Starting opens a fresh session in the same directory.
        </div>
      )}
    </div>
  );
}
