import { useState } from "react";
import type { JSX } from "react";

import { Icon } from "./Icon";

interface McpAuthRestartNoticeProps {
  restarting: boolean;
  onRestart: () => Promise<void>;
}

/** A scoped, non-blocking recovery action for one stale coding-agent runtime. */
export function McpAuthRestartNotice({
  restarting,
  onRestart,
}: McpAuthRestartNoticeProps): JSX.Element {
  const [requested, setRequested] = useState(false);
  const pending = restarting || requested;
  const handleRestart = async (): Promise<void> => {
    if (pending) return;
    setRequested(true);
    try {
      await onRestart();
    } catch {
      // The shared harness state presents the server's reason as a toast.
    } finally {
      setRequested(false);
    }
  };

  return (
    <div
      className="connectivity-banner"
      role="status"
      aria-live="polite"
      data-testid="mcp-auth-restart-notice"
    >
      <span className="connectivity-banner-icon" aria-hidden="true">
        <Icon name="TriangleAlert" size={14} />
      </span>
      <span className="connectivity-banner-text">
        {pending
          ? "Restarting this session with the current Sapiom connection…"
          : "The Sapiom connection changed. Restart to reconnect; in-progress work will stop."}
      </span>
      <button
        type="button"
        className="btn-ghost"
        data-testid="mcp-auth-restart"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void handleRestart()}
      >
        {pending ? "Restarting…" : "Restart session"}
      </button>
    </div>
  );
}
