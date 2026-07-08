import { useState } from "react";
import type { JSX } from "react";
import type { HarnessKind, HarnessSession, SessionSummary } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import { Icon } from "./Icon";
import { NewSessionModal } from "./NewSessionModal";
import { SettingsPopover } from "./SettingsPopover";

interface SessionBarProps {
  sessions: HarnessSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onResumeHistory: (summary: SessionSummary) => void;
  history: SessionSummary[];
  historyLoading: boolean;
  onOpenDropdown: (cwd: string) => void;
  recentDirs: string[];
  launchDir: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onCreateSession: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** The active session's bound workflow name ("working on X" chip), if any. */
  boundWorkflowName: string | null;
  authenticated: boolean;
  organizationName: string | null;
  telemetryOptIn: boolean;
  onToggleTelemetry: (next: boolean) => Promise<void>;
  /** Sessions with output activity in roughly the last 3s — pulses their tab. */
  busySessionIds: Set<string>;
}

export function SessionBar({
  sessions,
  activeSessionId,
  onSelectSession,
  onResumeHistory,
  history,
  historyLoading,
  onOpenDropdown,
  recentDirs,
  launchDir,
  listDir,
  onCreateSession,
  boundWorkflowName,
  authenticated,
  organizationName,
  telemetryOptIn,
  onToggleTelemetry,
  busySessionIds,
}: SessionBarProps): JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

  const toggleHistory = (): void => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) {
      const cwd = activeSession?.cwd ?? recentDirs[0];
      if (cwd) onOpenDropdown(cwd);
    }
  };

  return (
    <div className="session-bar">
      <div className="session-tabs" data-testid="session-tabs">
        {sessions.length === 0 && <span className="session-tabs-empty">No session</span>}
        {sessions.map((session) => (
          <button
            key={session.id}
            className={
              "session-tab" +
              (session.id === activeSessionId ? " is-active" : "") +
              (busySessionIds.has(session.id) ? " is-busy" : "")
            }
            // Dead sessions keep their pre-existing testid convention (many
            // specs already key off it); a running/starting one gets a
            // parallel, id-scoped testid for anything that needs to target
            // a specific tab rather than "whichever is active."
            data-testid={session.status === "exited" ? `exited-session-${session.id}` : `session-tab-${session.id}`}
            title={session.cwd}
            onClick={() => onSelectSession(session.id)}
          >
            <span className="session-dot" data-status={session.status} />
            <span className="session-tab-title">{session.title}</span>
          </button>
        ))}
      </div>

      {boundWorkflowName && (
        <span className="session-workflow-chip" data-testid="session-workflow-chip">
          ▸ working on {boundWorkflowName}
        </span>
      )}

      <div className="session-history-wrap">
        <button
          className="session-history-trigger"
          aria-label="Session history"
          data-testid="session-history-trigger"
          onClick={toggleHistory}
        >
          <Icon name="Clock" size={13} />
        </button>

        {historyOpen && (
          <div className="session-dropdown-menu">
            <div className="session-dropdown-section">History</div>
            {historyLoading && <div className="session-dropdown-empty">Loading…</div>}
            {!historyLoading && history.length === 0 && (
              <div className="session-dropdown-empty">No past sessions for this directory</div>
            )}
            {!historyLoading &&
              history.map((summary) => (
                <button
                  key={summary.agentSessionId}
                  className="session-dropdown-item"
                  data-testid={`history-${summary.agentSessionId}`}
                  onClick={() => {
                    onResumeHistory(summary);
                    setHistoryOpen(false);
                  }}
                >
                  <span className="session-item-title">{summary.title}</span>
                  <span className="session-item-meta">
                    {summary.harness} · {new Date(summary.lastActiveAt).toLocaleString()}
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>

      <button className="new-session-btn" data-testid="new-session-btn" onClick={() => setModalOpen(true)}>
        <Icon name="Plus" size={14} /> new
      </button>

      <div className="settings-wrap">
        <button
          className="gear-btn"
          aria-label="Settings"
          data-testid="settings-trigger"
          onClick={() => setSettingsOpen((prev) => !prev)}
        >
          <Icon name="Settings" size={16} />
        </button>
        {settingsOpen && (
          <SettingsPopover
            authenticated={authenticated}
            organizationName={organizationName}
            telemetryOptIn={telemetryOptIn}
            onToggleTelemetry={onToggleTelemetry}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>

      {modalOpen && (
        <NewSessionModal
          recentDirs={recentDirs}
          launchDir={launchDir}
          listDir={listDir}
          onClose={() => setModalOpen(false)}
          onCreate={onCreateSession}
        />
      )}
    </div>
  );
}
