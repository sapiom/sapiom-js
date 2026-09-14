import { useEffect, useRef, useState } from "react";
import type { HarnessSession } from "@shared/types";
import { Icon } from "./Icon";

export function DormantTerminalPane({
  session,
  authRevision,
  ending,
  onStart,
}: {
  session: HarnessSession;
  authRevision: number;
  ending: boolean;
  onStart: (signal: AbortSignal) => Promise<boolean>;
}) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [session.id, authRevision]);
  const start = async () => {
    if (pending.current) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError(null);
    try {
      if (!(await onStart(abort.signal)) && !abort.signal.aborted)
        setError(
          "The session changed while Terminal was starting. Check its current state before trying again.",
        );
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Terminal could not be started. Try again.",
        );
    } finally {
      if (pending.current === abort) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <div className="dead-session-pane" data-testid="dormant-terminal-pane">
      <div className="dead-session-summary">
        <span className="empty-state-icon" aria-hidden="true">
          <Icon name="SquareTerminal" size={18} />
        </span>
        <div className="dead-session-title">Terminal has not started</div>
        <div className="dead-session-meta">{session.cwd}</div>
        <p className="dead-session-resume-reason">
          Start a terminal for your coding agent in this session's workspace.
        </p>
        <div className="dead-session-actions">
          <button
            className="btn-primary"
            disabled={busy || ending}
            onClick={() => void start()}
          >
            {busy ? "Starting Terminal…" : "Start Terminal"}
          </button>
        </div>
        {ending && (
          <p className="dead-session-resume-reason" role="status">
            Finish ending this session before starting Terminal.
          </p>
        )}
        {error && (
          <p className="dead-session-resume-reason" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
