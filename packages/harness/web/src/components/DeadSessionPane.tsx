import type { JSX } from "react";
import type { HarnessSession } from "@shared/types";

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
 * Resume is only offered when the session has an agentSessionId — without
 * one the agent never established its own session, so there is nothing to
 * hand off to. The button is disabled with an explanation in that case so
 * the user isn't left clicking a button that silently does nothing.
 */
export function DeadSessionPane({ session, onResume, onClose }: DeadSessionPaneProps): JSX.Element {
  // A session that exited before the agent established its own session id has
  // nothing to resume against — the server will return SessionNotResumeableError.
  const canResume = session.agentSessionId != null;

  return (
    <div className="dead-session-pane" data-testid="dead-session-pane">
      <div className="dead-session-title">Session exited</div>
      <div className="dead-session-meta">
        {session.cwd}
        {session.exitCode != null && ` · exit code ${session.exitCode}`}
      </div>
      <div className="dead-session-actions">
        <button
          className="btn-primary"
          data-testid="dead-session-resume"
          onClick={onResume}
          disabled={!canResume}
          title={canResume ? undefined : "This session can't be resumed — it exited before establishing a session id"}
        >
          Resume
        </button>
        <button className="btn-ghost" data-testid="dead-session-close" onClick={onClose}>
          Close
        </button>
      </div>
      {!canResume && (
        <div className="dead-session-resume-reason" data-testid="dead-session-resume-reason">
          This session can't be resumed — it exited before establishing a session id.
        </div>
      )}
    </div>
  );
}
