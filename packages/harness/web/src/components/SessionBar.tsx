import { useRef, useState } from "react";
import type { JSX } from "react";
import type { HarnessSession } from "@shared/types";

import { HARNESS_LABELS } from "../lib/history-meta";
import { AnchoredPopover } from "./AnchoredPopover";
import { EndSessionConfirm } from "./EndSessionConfirm";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { Icon } from "./Icon";

/** One labeled state for the session, not a bare dot: what the user reads is
 *  the SESSION's condition — distinct from the agent's Draft/Deployed chip on
 *  the subheader, which describes the workflow, not this terminal. */
function sessionStateLabel(session: HarnessSession, busy: boolean): string {
  if (session.status === "exited") return "exited";
  if (busy) return "busy";
  if (session.status === "running") return "live";
  return session.status;
}

/** The workspace a session belongs to is its directory's basename — the
 *  same label the rail's workspace group carries. */
function workspaceLabelOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

interface SessionBarProps {
  /** The main panel is showing the Overview/intro, not a session. */
  overviewMode?: boolean;
  /** Set while an agent is open whose workspace has no live session: the
   *  header names that agent (matching the "start a session" pane below), and
   *  the session verbs drop out since there is no session to act on. */
  openedAgentName?: string | null;
  /** Set while a PAST session is under review: the header shows its
   *  title instead of the active session's, matching the pane below. */
  reviewTitle?: string | null;
  /** The session the main panel is showing, if any. */
  activeSession: HarnessSession | null;
  /** The session's display name (session-name.ts: rename > transcript title
   *  > folder basename) — what the header title shows and rename edits. */
  sessionName: string | null;
  /** Persists a user rename (client-side). */
  onRenameSession: (id: string, name: string) => void;
  /** The active session's bound workflow name ("working on X" chip), if any. */
  boundWorkflowName: string | null;
  /** The active session produced terminal output in roughly the last ~3s. */
  busy: boolean;
  /** Set while the rail is collapsed — renders the expand affordance first. */
  onExpandRail: (() => void) | null;
  /** Set while the right pane is collapsed — renders the expand affordance last. */
  onExpandRight: (() => void) | null;
  /** Ends a live session — kills its PTY; it stays resumable from history when it has an agent session id. */
  onCloseSession: (id: string) => void;
  /** Opens the session's directory in the user's editor. */
  onOpenInEditor: (path: string) => void;
  /** Push a message onto the app's toast rail — the ⋯ menu's Copy path
   *  confirms the same way the rail's copy action does. */
  onToast: (message: string) => void;
  /** Which surface the session slot is showing. State lives in App — both
   *  surfaces stay mounted there so a flip never tears down the pty. */
  agentView: "chat" | "terminal";
  onSetAgentView: (view: "chat" | "terminal") => void;
}

/**
 * Compact context header for the main panel — like Claude Code's own header:
 * which agent, which session, where, and its live status. Session SWITCHING
 * and creation live in the tab strip below it; this is purely the
 * active session's identity and state.
 */
export function SessionBar({
  overviewMode = false,
  openedAgentName = null,
  reviewTitle = null,
  activeSession,
  sessionName,
  onRenameSession,
  boundWorkflowName,
  busy,
  onExpandRail,
  onExpandRight,
  onCloseSession,
  onOpenInEditor,
  onToast,
  agentView,
  onSetAgentView,
}: SessionBarProps): JSX.Element {
  // Ending a live session kills a real PTY — the option opens a confirm dialog.
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Inline rename in the header title (the ⋯ menu's "Rename session" —
  // client-side persistence).
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = (): void => setMenuOpen(false);
  const commitRename = (): void => {
    if (activeSession) onRenameSession(activeSession.id, renameDraft);
    setRenaming(false);
  };

  return (
    <div className="session-bar">
      {onExpandRail && (
        <button
          className="gear-btn"
          data-testid="rail-expand"
          aria-label="Expand workspace panel"
          title="Expand workspace panel"
          onClick={onExpandRail}
        >
          <Icon name="Menu" size={15} />
        </button>
      )}

      <div
        className="session-context"
        data-testid="session-context"
        data-session-id={activeSession?.id ?? ""}
      >
        {overviewMode ? (
          <>
            <Icon name="Radio" size={13} />
            <span className="session-context-title" data-testid="session-context-title">
              Overview
            </span>
          </>
        ) : openedAgentName ? (
          /* An agent is open with no live session in its workspace — the
             header names it (matching the pane below) and carries an honest
             "no session" tag, no live status and no session verbs. */
          <>
            <Icon name="Zap" size={13} />
            <span className="session-context-title" data-testid="session-context-title">
              {openedAgentName}
            </span>
            <span
              className="status-tag session-status-tag session-context-status"
              data-testid="session-status-tag"
              data-status="none"
              data-tooltip="No running session for this agent. Start one to work on it."
            >
              no session
            </span>
          </>
        ) : reviewTitle ? (
          /* Past-session review: the header mirrors the pane below —
             nothing is running here, so no live status and no session verbs. */
          <>
            <Icon name="History" size={13} />
            <span className="session-context-title" data-testid="session-context-title">
              {reviewTitle}
            </span>
            <span
              className="status-tag session-status-tag session-context-status"
              data-testid="session-status-tag"
              data-status="exited"
              data-tooltip="A past session under review. Resume it from the pane below."
            >
              <span className="session-dot" data-status="exited" />
              past
            </span>
          </>
        ) : activeSession ? (
          /* Compact identity: harness glyph + session name only. The
             workspace and full path live in the hover tooltip so the header
             never bleeds — nothing here competes with the terminal below. */
          <>
            <HarnessBrandIcon kind={activeSession.harness} size={13} />
            {renaming ? (
              <input
                className="group-name-input session-rename-input session-context-rename"
                data-testid="session-rename-input"
                value={renameDraft}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={commitRename}
              />
            ) : (
              <span
                className="session-context-title"
                data-testid="session-context-title"
                data-tooltip={`${HARNESS_LABELS[activeSession.harness]} · ${workspaceLabelOf(activeSession.cwd)} · ${activeSession.cwd}`}
              >
                {sessionName ?? activeSession.title}
              </span>
            )}
            {boundWorkflowName && (
              <span
                className="session-workflow-chip"
                data-testid="session-workflow-chip"
                data-tooltip={`Bound to ${boundWorkflowName}; shown in Canvas`}
              >
                · {boundWorkflowName}
              </span>
            )}
            <span
              className="status-tag session-status-tag session-context-status"
              data-testid="session-status-tag"
              data-status={activeSession.status}
              data-tooltip={
                busy
                  ? "The agent produced output in the last few seconds"
                  : activeSession.status === "running"
                    ? "Session is live; the terminal is connected"
                    : activeSession.status === "exited"
                      ? "Session ended; resume it from the dead-session pane or history"
                      : "Session is starting"
              }
            >
              {busy ? (
                <span className="session-busy" data-testid="session-busy" aria-hidden="true" />
              ) : (
                <span className="session-dot" data-status={activeSession.status} />
              )}
              {sessionStateLabel(activeSession, busy)}
            </span>
          </>
        ) : (
          <span className="session-context-none">No active session</span>
        )}
      </div>

      {/* Chat | Terminal switch for the live session slot — icon-only
          segments on the header's shared icon-button scale. Hidden for the
          overview, past-session review, and dead sessions, where neither
          surface is showing. */}
      {!overviewMode && !reviewTitle && !openedAgentName && activeSession && activeSession.status !== "exited" && (
        <div className="session-view-toggle" role="group" aria-label="Session view">
          <button
            type="button"
            className="theme-toggle session-view-btn"
            data-testid="agent-tab-chat"
            aria-pressed={agentView === "chat"}
            aria-controls="agent-panel-chat"
            aria-label="Chat"
            data-tooltip="Chat"
            onClick={() => onSetAgentView("chat")}
          >
            <Icon name="MessageSquare" size={14} />
          </button>
          <button
            type="button"
            className="theme-toggle session-view-btn"
            data-testid="agent-tab-terminal"
            aria-pressed={agentView === "terminal"}
            aria-controls="agent-panel-terminal"
            aria-label="Terminal"
            data-tooltip="Terminal"
            onClick={() => onSetAgentView("terminal")}
          >
            <Icon name="SquareTerminal" size={14} />
          </button>
        </div>
      )}

      {/* Session options as a ⋯ menu (never in overview, review, or opened-
          agent mode — destructive session actions there would read as closing
          the view, or act on a session the header isn't even showing). */}
      {!overviewMode && !reviewTitle && !openedAgentName && activeSession && (
        <div className="session-menu-wrap">
          <button
            ref={menuTriggerRef}
            className="theme-toggle"
            data-testid="session-menu"
            aria-label="Session options"
            data-tooltip="Session options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="MoreHorizontal" size={14} />
          </button>
          {/* Portaled (AnchoredPopover) so no header/pane overflow can crop it. */}
          <AnchoredPopover
            open={menuOpen}
            anchorRef={menuTriggerRef}
            onDismiss={closeMenu}
            placement="down-end"
            className="session-menu"
            role="menu"
            testid="session-menu-popover"
          >
              <button
                role="menuitem"
                className="profile-menu-item"
                onClick={() => {
                  // Same confirm/failure pair as the rail's copy action
                  // One verb, one micro-interaction.
                  void navigator.clipboard
                    ?.writeText(activeSession.cwd)
                    .then(() => onToast("Path copied."))
                    .catch(() => onToast("Couldn't copy the path."));
                  closeMenu();
                }}
              >
                <Icon name="Copy" size={13} />
                Copy path
              </button>
              <button
                role="menuitem"
                className="profile-menu-item"
                data-testid="session-rename"
                onClick={() => {
                  setRenameDraft(sessionName ?? activeSession.title);
                  setRenaming(true);
                  closeMenu();
                }}
              >
                <Icon name="Pencil" size={13} />
                Rename session
              </button>
              <button
                role="menuitem"
                className="profile-menu-item"
                data-testid="session-open-editor"
                onClick={() => {
                  onOpenInEditor(activeSession.cwd);
                  closeMenu();
                }}
              >
                <Icon name="Code" size={13} />
                Open in editor
              </button>
              {activeSession.status !== "exited" && (
                <button
                  role="menuitem"
                  className="profile-menu-item session-menu-danger"
                  data-testid="session-end-btn"
                  onClick={() => {
                    closeMenu();
                    setConfirmingClose(true);
                  }}
                >
                  <Icon name="X" size={13} />
                  End session…
                </button>
              )}
          </AnchoredPopover>
        </div>
      )}

      {onExpandRight && (
        <button
          className="gear-btn"
          data-testid="right-expand"
          aria-label="Expand canvas panel"
          title="Expand canvas panel"
          onClick={onExpandRight}
        >
          <Icon name="List" size={15} />
        </button>
      )}

      {confirmingClose && activeSession && (
        <EndSessionConfirm
          triggerRef={menuTriggerRef}
          onCancel={() => setConfirmingClose(false)}
          onConfirm={() => {
            setConfirmingClose(false);
            onCloseSession(activeSession.id);
          }}
        />
      )}
    </div>
  );
}
