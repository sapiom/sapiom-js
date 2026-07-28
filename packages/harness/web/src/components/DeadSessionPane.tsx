import type { JSX } from "react";
import type { HarnessSession, SessionRecord, SessionResumeMode, SessionSummary } from "@shared/types";

import { HARNESS_LABELS, formatDuration, formatRelativeTime, historyRowMeta } from "../lib/history-meta";
import { useSessionRecord, type SessionRecordState } from "../lib/use-session-record";
import { Icon } from "./Icon";
import { SessionTranscript } from "./SessionTranscript";

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
  /** Fetches the reconstructed transcript; resolves null when nothing was recorded. */
  loadRecord: (id: string) => Promise<SessionRecord | null>;
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
 * Context comes from the session record itself: title, agent, duration, when
 * it ended, exit code. The registry keeps no scrollback for an exited pty, so
 * there is no last-output tail to show.
 *
 * What it CAN show is the conversation, rebuilt from the harness's own recorded
 * events (see {@link SessionTranscript}) — the pty's scrollback is gone, our
 * recording of it isn't. Sessions with nothing recorded keep exactly the pane
 * they had: metadata only, honest absence, never a fabricated tail.
 *
 * Resume is offered only when the AGENT still holds the conversation, which is
 * a question about the agent's own store, not about whether we captured an
 * `agentSessionId` (we capture that from the SessionStart hook, long before
 * there's anything worth resuming). The button is disabled with the real
 * reason otherwise, so the user isn't left clicking a button whose only
 * possible outcome is `exit code 1` and this same pane again.
 *
 * Note the two are independent: a session the agent can't resume can still
 * have a full transcript here, because that transcript comes from our events
 * rather than from the agent's store. "Can't be continued" is not "can't be
 * read", and this pane no longer conflates them.
 */
export function DeadSessionPane({
  session,
  resumeMode,
  loadRecord,
  onResume,
  onClose,
}: DeadSessionPaneProps): JSX.Element {
  const canResume = session.agentSessionId != null && resumeMode !== "rehydrate";
  const duration = formatDuration(session.createdAt, session.lastActiveAt);
  const record = useSessionRecord(session.id, loadRecord);
  // "empty" collapses the section entirely rather than showing an empty box:
  // the metadata card alone is the honest pane for a session we never recorded.
  const showRecord = record.status !== "empty";

  return (
    <div className="dead-session-pane" data-testid="dead-session-pane" data-has-record={showRecord}>
      <div className="dead-session-summary">
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

      {showRecord && (
        <div className="dead-session-record" data-testid="dead-session-record">
          <SessionRecordBody state={record} />
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
 *
 * It is also the session's transcript. Relaunching the agent to "show" a past
 * session never worked — a CLI redraws its own scrollback into a pty and the
 * Studio sees pixels, not content — so the transcript here is rebuilt from the
 * harness's own recorded events instead (`GET /api/sessions/:id/record`). That
 * reads the same for Claude Code and Codex and survives the vendor deleting its
 * own history, at the cost of being a reconstruction — which
 * {@link SessionTranscript} labels as such. It is also why a `rehydrate` row
 * still shows its conversation: our recording doesn't depend on the agent's.
 */
export function PastSessionPane({
  summary,
  loadRecord,
  onStart,
  onClose,
}: {
  summary: SessionSummary;
  /** Fetches the reconstructed record; resolves null when nothing was recorded. */
  loadRecord: (id: string) => Promise<SessionRecord | null>;
  onStart: () => void;
  onClose: () => void;
}): JSX.Element {
  const resumable = summary.resumeMode === "agent-resume";
  // The registry's own id when it tracked the session, else the agent's — the
  // server resolves either (see core/session-record.ts's resolveSessionIds).
  const recordId = summary.harnessSessionId ?? summary.agentSessionId;
  const record = useSessionRecord(recordId, loadRecord);

  return (
    <div className="past-session-pane" data-testid="past-session-pane">
      <header className="past-session-header">
        <div className="past-session-heading">
          <div className="dead-session-title">{summary.title}</div>
          <div className="dead-session-meta">
            {historyRowMeta(summary)} · {summary.cwd}
          </div>
        </div>
        <div className="dead-session-actions">
          <button className="btn-primary" data-testid="past-session-start" onClick={onStart}>
            {resumable ? "Resume" : "New session here"}
          </button>
          <button className="btn-ghost" data-testid="past-session-close" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      {!resumable && (
        <div className="dead-session-resume-reason" data-testid="past-session-reason">
          {HARNESS_LABELS[summary.harness]} has no saved conversation for this session, so it can't
          be reattached — sessions that end before their first prompt are never written to the
          agent's history. Starting opens a fresh session in the same directory.
        </div>
      )}

      <div className="past-session-body">
        <SessionRecordBody state={record} />
      </div>
    </div>
  );
}

/**
 * The four states of a record fetch, rendered the same way wherever a
 * transcript appears. An absent record is stated plainly — it is the one thing
 * this view must never quietly turn into "an empty session".
 */
function SessionRecordBody({ state }: { state: SessionRecordState }): JSX.Element {
  if (state.status === "loading") {
    return (
      <div className="past-session-status" data-testid="past-session-loading">
        Rebuilding this session's transcript…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="past-session-status" data-testid="past-session-error">
        Couldn't load this session's transcript: {state.message}
      </div>
    );
  }
  if (state.status === "empty") {
    return (
      <div className="past-session-status" data-testid="past-session-empty">
        <span className="empty-state-icon" aria-hidden="true">
          <Icon name="SquareTerminal" size={18} />
        </span>
        No transcript for this session: the harness has no recorded events for it. Sessions the
        Studio didn't run — or ones whose events have aged out of the local log — show up here as
        history rows only.
      </div>
    );
  }
  return <SessionTranscript record={state.record} />;
}
