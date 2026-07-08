import { useMemo, useState } from "react";
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
  onOpenHistory: (cwd: string) => void;
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
  /** Session ids with terminal output in roughly the last ~3s — renders a
   *  busy pulse on that session's tab regardless of whether it's active. */
  busySessionIds: Set<string>;
}

export function SessionBar({
  sessions,
  activeSessionId,
  onSelectSession,
  onResumeHistory,
  history,
  historyLoading,
  onOpenHistory,
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

  // One tab per live session, oldest-first — a stable order Cmd+1..9 relies
  // on (App.tsx computes the same ordering for the keyboard shortcut) and
  // that keeps a tab from jumping around the strip as sessions update.
  const tabs = useMemo(
    () =>
      sessions.filter((session) => session.status !== "exited").sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [sessions],
  );
  // Reachable from the history menu even though they're not "running" — so a
  // session that died stays selectable (to inspect/resume/close it) instead
  // of only being escapable. Kept out of the tab strip itself so it doesn't
  // fill up with dead tabs.
  const exitedSessions = sessions.filter((session) => session.status === "exited");

  const toggleHistory = (): void => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) {
      const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
      const cwd = activeSession?.cwd ?? recentDirs[0];
      if (cwd) onOpenHistory(cwd);
    }
  };

  return (
    <div className="session-bar">
      <div className="session-tabs" role="tablist" data-testid="session-tabs">
        {tabs.map((session) => {
          const isActive = session.id === activeSessionId;
          return (
            <button
              key={session.id}
              role="tab"
              aria-selected={isActive}
              className={"session-tab" + (isActive ? " is-active" : "")}
              data-testid={`session-tab-${session.id}`}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="session-dot" data-status={session.status} />
              <span className="session-tab-title">{session.title}</span>
              {busySessionIds.has(session.id) && (
                <span
                  className="session-tab-busy"
                  data-testid={`session-tab-busy-${session.id}`}
                  aria-hidden="true"
                />
              )}
              {isActive && boundWorkflowName && (
                <span className="session-workflow-chip" data-testid="session-workflow-chip">
                  ▸ working on {boundWorkflowName}
                </span>
              )}
            </button>
          );
        })}

        <button
          className="session-tab-add"
          data-testid="new-session-btn"
          onClick={() => setModalOpen(true)}
          aria-label="New session"
          title="New session"
        >
          <Icon name="Plus" size={14} />
        </button>
      </div>

      <div className="session-history-wrap">
        <button
          className="session-history-trigger"
          data-testid="history-trigger"
          onClick={toggleHistory}
          aria-label="Session history"
          title="Session history"
        >
          <Icon name="History" size={14} />
          {exitedSessions.length > 0 && (
            <span className="session-history-badge" data-testid="session-history-badge">
              {exitedSessions.length}
            </span>
          )}
        </button>

        {historyOpen && (
          <div className="session-dropdown-menu" data-testid="history-menu">
            <div className="session-dropdown-section">Exited</div>
            {exitedSessions.length === 0 && <div className="session-dropdown-empty">No exited sessions</div>}
            {exitedSessions.map((session) => (
              <button
                key={session.id}
                data-testid={`exited-session-${session.id}`}
                className={"session-dropdown-item" + (session.id === activeSessionId ? " is-selected" : "")}
                onClick={() => {
                  onSelectSession(session.id);
                  setHistoryOpen(false);
                }}
              >
                <span className="session-dot" data-status={session.status} />
                <span className="session-item-title">{session.title}</span>
                <span className="session-item-cwd">{session.cwd}</span>
              </button>
            ))}

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
