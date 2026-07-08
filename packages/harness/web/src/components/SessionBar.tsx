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
  authenticated: boolean;
  organizationName: string | null;
  telemetryOptIn: boolean;
  onToggleTelemetry: (next: boolean) => Promise<void>;
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
  authenticated,
  organizationName,
  telemetryOptIn,
  onToggleTelemetry,
}: SessionBarProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const runningSessions = sessions.filter((session) => session.status !== "exited");
  // Reachable here even though they're not "running" — so a session that died stays
  // selectable (to inspect/resume/close it) instead of only being escapable.
  const exitedSessions = sessions.filter((session) => session.status === "exited");

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) {
      const cwd = activeSession?.cwd ?? recentDirs[0];
      if (cwd) onOpenDropdown(cwd);
    }
  };

  return (
    <div className="session-bar">
      <div className="session-dropdown-wrap">
        <button className="session-dropdown-trigger" data-testid="session-dropdown-trigger" onClick={toggle}>
          <span className="session-dot" data-status={activeSession?.status ?? "none"} />
          <span className="session-title">{activeSession ? activeSession.title : "No session"}</span>
          <Icon name="ChevronDown" size={14} />
        </button>

        {open && (
          <div className="session-dropdown-menu">
            <div className="session-dropdown-section">Running</div>
            {runningSessions.length === 0 && <div className="session-dropdown-empty">No running sessions</div>}
            {runningSessions.map((session) => (
              <button
                key={session.id}
                className={"session-dropdown-item" + (session.id === activeSessionId ? " is-selected" : "")}
                onClick={() => {
                  onSelectSession(session.id);
                  setOpen(false);
                }}
              >
                <span className="session-dot" data-status={session.status} />
                <span className="session-item-title">{session.title}</span>
                <span className="session-item-cwd">{session.cwd}</span>
              </button>
            ))}

            {exitedSessions.length > 0 && (
              <>
                <div className="session-dropdown-section">Exited</div>
                {exitedSessions.map((session) => (
                  <button
                    key={session.id}
                    data-testid={`exited-session-${session.id}`}
                    className={"session-dropdown-item" + (session.id === activeSessionId ? " is-selected" : "")}
                    onClick={() => {
                      onSelectSession(session.id);
                      setOpen(false);
                    }}
                  >
                    <span className="session-dot" data-status={session.status} />
                    <span className="session-item-title">{session.title}</span>
                    <span className="session-item-cwd">{session.cwd}</span>
                  </button>
                ))}
              </>
            )}

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
                    setOpen(false);
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
