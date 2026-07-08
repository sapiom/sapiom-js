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
 */
export function DeadSessionPane({ session, onResume, onClose }: DeadSessionPaneProps): JSX.Element {
  return (
    <div className="dead-session-pane" data-testid="dead-session-pane">
      <div className="dead-session-title">Session exited</div>
      <div className="dead-session-meta">
        {session.cwd}
        {session.exitCode != null && ` · exit code ${session.exitCode}`}
      </div>
      <div className="dead-session-actions">
        <button className="btn-primary" data-testid="dead-session-resume" onClick={onResume}>
          Resume
        </button>
        <button className="btn-ghost" data-testid="dead-session-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
