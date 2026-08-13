import { useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { HarnessSession } from "@shared/types";

import { HARNESS_LABELS, formatRelativeTime } from "../lib/history-meta";
import { basenameOf } from "../lib/paths";
import type { ToastTone } from "../lib/toast";
import { AnchoredPopover } from "./AnchoredPopover";
import { EndSessionConfirm } from "./EndSessionConfirm";
import { Icon } from "./Icon";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/** The workspace a session belongs to is its directory's basename — the
 *  same label the rail's workspace group carries. */
function workspaceLabelOf(path: string): string {
  return basenameOf(path);
}

interface SessionBarProps {
  /** The main panel is showing the Overview/intro, not a session. */
  overviewMode?: boolean;
  /** Set while an agent is open whose workspace has no live session. */
  openedAgentName?: string | null;
  /** Set while a PAST session is under review. */
  reviewTitle?: string | null;
  /** Set while the composer-first "new session" home is up — no session yet. */
  composing?: boolean;
  /** Leaves the composer for the session it was opened over. Set only when such
   *  a session exists — the bar then reads as the Back affordance itself. */
  onBack?: (() => void) | null;
  /** The session the main panel is showing, if any. */
  activeSession: HarnessSession | null;
  /** The active session's display name (rename > transcript title > folder). */
  sessionName: string | null;
  /** Persists a user rename (client-side). */
  onRenameSession: (id: string, name: string) => void;
  /** The active session's bound workflow name ("· leasing" chip), if any. */
  boundWorkflowName: string | null;
  /** The active session produced terminal output in roughly the last ~3s. */
  busy: boolean;
  /** Set while the rail is collapsed — renders the expand affordance first. */
  onExpandRail: (() => void) | null;
  /** Set while the right pane is collapsed — renders the expand affordance last. */
  onExpandRight: (() => void) | null;
  /** Ends a live session — kills its PTY; it stays resumable from history. */
  onCloseSession: (id: string) => void;
  /** Opens the session's directory in the user's editor. */
  onOpenInEditor: (path: string) => void;
  /** The chosen editor's display name, so the item names where it lands. */
  editorLabel: string;
  /** Push a message onto the app's toast rail. Defaults to the "error" tone;
   *  result announcements opt into "info". */
  onToast: (message: string, tone?: ToastTone) => void;
  /** The agent action cluster (globe/Test/Run/Deploy), right-anchored. */
  actions?: ReactNode;
  /** Start a new session (the + at the end of the queue). */
  onNewSession?: (() => void) | null;
  /** The focused agent's live sessions, for the inline switcher. */
  sessions?: HarnessSession[];
  /** Switch the active session (clicking another session's chip). */
  onSelectSession?: ((id: string) => void) | null;
  /** Display name for a session chip (rename > title > folder). */
  labelOf?: (session: HarnessSession) => string;
}

/**
 * The single main-panel header. It carries, on one horizontally-scrollable row:
 * the session QUEUE on the left (the current session as an options dropdown —
 * its title ⌄ opens Copy path / Rename / Open in editor / End session — then
 * the focused agent's OTHER live sessions as switch chips, then a + to add one),
 * and the agent ACTIONS on the right. No harness glyph, no separate tab lane,
 * no standalone ⋯ menu: identity, switching, and actions read as one bar.
 */
export function SessionBar({
  overviewMode = false,
  openedAgentName = null,
  reviewTitle = null,
  composing = false,
  onBack = null,
  activeSession,
  sessionName,
  onRenameSession,
  boundWorkflowName,
  busy,
  onExpandRail,
  onExpandRight,
  onCloseSession,
  onOpenInEditor,
  editorLabel,
  onToast,
  actions = null,
  onNewSession = null,
  sessions = [],
  onSelectSession = null,
  labelOf,
}: SessionBarProps): JSX.Element {
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = (): void => setMenuOpen(false);
  const commitRename = (): void => {
    if (activeSession) onRenameSession(activeSession.id, renameDraft);
    setRenaming(false);
  };

  const others = activeSession ? sessions.filter((s) => s.id !== activeSession.id) : [];
  // The switcher lists every live session of this agent, active one first.
  const orderedSessions = activeSession ? [activeSession, ...others] : [];

  return (
    <div className="session-bar" {...trackingAttrs({ surface: "session_bar" })}>
      {onExpandRail && (
        <button
          className="theme-toggle rail-toggle"
          data-testid="rail-expand"
          aria-label="Expand workspace panel"
          title="Expand workspace panel"
          onClick={onExpandRail}
        >
          <Icon name="PanelLeftOpen" size={14} />
        </button>
      )}

      <div
        className="session-queue"
        data-testid="session-context"
        data-session-id={activeSession?.id ?? ""}
      >
        {overviewMode ? (
          <div className="session-current session-current-static">
            <Icon name="Radio" size={13} />
            <span className="session-context-title" data-testid="session-context-title">
              Overview
            </span>
          </div>
        ) : openedAgentName ? (
          /* An agent is open with no live session in its workspace. */
          <div className="session-current session-current-static">
            <span className="session-context-title" data-testid="session-context-title">
              {openedAgentName}
            </span>
            <span
              className="status-tag session-status-tag"
              data-testid="session-status-tag"
              data-status="none"
              data-tooltip="No running session for this agent. Start one to work on it."
            >
              no session
            </span>
          </div>
        ) : reviewTitle ? (
          /* Past-session review: nothing is running here. */
          <div className="session-current session-current-static">
            <Icon name="History" size={13} />
            <span className="session-context-title" data-testid="session-context-title">
              {reviewTitle}
            </span>
            <span
              className="status-tag session-status-tag"
              data-testid="session-status-tag"
              data-status="exited"
              data-tooltip="A past session under review. Resume it from the pane below."
            >
              <span className="session-dot" data-status="exited" />
              past
            </span>
          </div>
        ) : composing ? (
          /* Composer-first "new session": there is no session to name here, so
             the slot carries the one thing it can do — go back to the session
             the composer was opened over. Nothing when there is none (first
             run, every session closed): the bar keeps only the + . */
          onBack ? (
            <button
              type="button"
              className="session-current session-back"
              data-testid="composer-back"
              onClick={onBack}
            >
              <Icon name="ArrowLeft" size={13} />
              <span className="session-context-title" data-testid="session-context-title">
                Back
              </span>
            </button>
          ) : null
        ) : activeSession ? (
          <>
            {/* Current session: the options dropdown (title ⌄). */}
            <div className="session-current-wrap">
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
                <button
                  ref={menuTriggerRef}
                  className="session-current session-title-trigger"
                  data-testid="session-menu"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  data-tooltip={`${HARNESS_LABELS[activeSession.harness]} · ${workspaceLabelOf(activeSession.cwd)} · ${activeSession.cwd}`}
                  onClick={() => setMenuOpen((v) => !v)}
                  // The tooltip embeds the absolute cwd (OS username included).
                  {...trackingAttrs({ object: "session" })}
                >
                  {busy ? (
                    <span className="session-busy" data-testid="session-busy" aria-hidden="true" />
                  ) : (
                    <span className="session-dot" data-status={activeSession.status} />
                  )}
                  <span className="session-context-title" data-testid="session-context-title">
                    {labelOf ? labelOf(activeSession) : (sessionName ?? activeSession.title)}
                  </span>
                  <Icon name="ChevronDown" size={13} />
                </button>
              )}
              <AnchoredPopover
                open={menuOpen}
                anchorRef={menuTriggerRef}
                onDismiss={closeMenu}
                placement="down-start"
                className="session-menu"
                role="menu"
                testid="session-menu-popover"
              >
                {/* Switcher: every live session of this agent, the active one
                    checked. Picking a row switches; the actions below act on the
                    current session. One place to select or act — no inline chips
                    crowding the bar. */}
                <div className="session-menu-section">Sessions</div>
                {orderedSessions.map((s) => {
                  const isActive = s.id === activeSession.id;
                  return (
                    <button
                      key={s.id}
                      role="menuitemradio"
                      aria-checked={isActive}
                      className={"profile-menu-item session-switch-item" + (isActive ? " is-selected" : "")}
                      data-testid={`session-switch-${s.id}`}
                      onClick={() => {
                        if (!isActive) onSelectSession?.(s.id);
                        closeMenu();
                      }}
                    >
                      <span className="session-dot" data-status={s.status} />
                      <span className="session-switch-label">{labelOf ? labelOf(s) : s.title}</span>
                      <span className="session-switch-meta">{formatRelativeTime(s.lastActiveAt)}</span>
                      {isActive && <Icon name="Check" size={13} />}
                    </button>
                  );
                })}
                {onNewSession && (
                  <button
                    role="menuitem"
                    className="profile-menu-item session-menu-new"
                    data-testid="session-new-menu"
                    onClick={() => {
                      onNewSession();
                      closeMenu();
                    }}
                  >
                    <Icon name="Plus" size={13} />
                    New session
                  </button>
                )}

                <div className="session-menu-divider" role="separator" />

                {/* Which agent's Canvas this session drives — moved off the bar
                    into the menu, where it reads as metadata, not a session. */}
                {boundWorkflowName && (
                  <div className="session-menu-bound" data-testid="session-workflow-chip">
                    Bound to <strong>{boundWorkflowName}</strong> · shown in Canvas
                  </div>
                )}

                <button
                  role="menuitem"
                  className="profile-menu-item"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(activeSession.cwd)
                      .then(() => onToast("Path copied.", "success"))
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
                  Open in {editorLabel}
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
          </>
        ) : (
          <span className="session-context-none">No active session</span>
        )}
      </div>

      {/* + : add a session — OUTSIDE the scrollable queue so it stays visible
          however long the session list grows. */}
      {/* No "new session" + while the composer IS the new-session screen — it's
          redundant there. Only alongside a live session. */}
      {onNewSession && activeSession && !composing && (
        <button
          className="session-new"
          data-testid="session-new"
          aria-label="New session"
          data-tooltip="New session"
          onClick={onNewSession}
        >
          <Icon name="Plus" size={15} />
        </button>
      )}

      {actions}

      {onExpandRight && (
        <button
          className="theme-toggle"
          data-testid="right-expand"
          aria-label="Expand canvas panel"
          title="Expand canvas panel"
          onClick={onExpandRight}
        >
          <Icon name="PanelRightOpen" size={15} />
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
