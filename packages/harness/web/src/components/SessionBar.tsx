import { AssistantActivity } from "./AssistantActivity";
import type { AssistantProjection } from "../lib/assistant-state";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode, RefObject } from "react";
import type { HarnessSession } from "@shared/types";

import { HARNESS_LABELS } from "../lib/history-meta";
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
  assistant?: AssistantProjection;
  /** The main panel is showing the Overview/intro, not a session. */
  overviewMode?: boolean;
  /** Set while an agent is open whose workspace has no live session. */
  openedAgentName?: string | null;
  /** Set while a PAST session is under review. */
  reviewTitle?: string | null;
  /** Set while the composer-first "new session" home is up — no session yet. */
  composing?: boolean;
  /** The project the new-agent screen is creating in, stated in the header
   *  chip (flow-creation.md §4.3): "New agent in {label}". */
  composerProjectLabel?: string | null;
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
  /** Accessible (and optionally visible) name for the right-pane affordance. */
  expandRightLabel?: string;
  showExpandRightLabel?: boolean;
  expandRightRef?: RefObject<HTMLButtonElement | null>;
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
}

/**
 * The single main-panel header. The rail is the session switcher now
 * (flow-navigation.md Q2), so there is no tab strip: the header names the
 * session on screen, and its title IS the session's options menu (Copy path /
 * Rename / Open in editor / End session), live or exited alike. Agent actions
 * remain right-anchored on the same row.
 */
export function SessionBar({
  assistant,
  overviewMode = false,
  openedAgentName = null,
  reviewTitle = null,
  composing = false,
  composerProjectLabel = null,
  onBack = null,
  activeSession,
  sessionName,
  onRenameSession,
  boundWorkflowName,
  busy,
  onExpandRail,
  onExpandRight,
  expandRightLabel = "Expand canvas panel",
  showExpandRightLabel = false,
  expandRightRef,
  onCloseSession,
  onOpenInEditor,
  editorLabel,
  onToast,
  actions = null,
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
  useEffect(() => {
    setMenuOpen(false);
    setRenaming(false);
    setConfirmingClose(false);
  }, [activeSession?.id]);

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
            <span
              className="session-context-title"
              data-testid="session-context-title"
            >
              Overview
            </span>
          </div>
        ) : openedAgentName ? (
          /* An agent is open with no live session in its workspace. */
          <div className="session-current session-current-static">
            <span
              className="session-context-title"
              data-testid="session-context-title"
            >
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
            <span
              className="session-context-title"
              data-testid="session-context-title"
            >
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
          /* The new-agent screen: there is no session to name here. The slot
             STATES the project the agent is being created in (§4.3, the
             header chip) and, when the screen was opened over a live session,
             carries the way back to it. */
          <div className="session-current session-composing">
            {onBack && (
              <button
                type="button"
                className="session-current session-back"
                data-testid="composer-back"
                onClick={onBack}
              >
                <Icon name="ArrowLeft" size={13} />
                <span
                  className="session-context-title"
                  data-testid="session-context-title"
                >
                  Back
                </span>
              </button>
            )}
            {composerProjectLabel && (
              <span
                className="session-project-chip"
                data-testid="session-project-chip"
                title={composerProjectLabel}
              >
                <Icon name="Folder" size={12} />
                New agent in {composerProjectLabel}
              </span>
            )}
          </div>
        ) : activeSession ? (
          <div className="session-current-wrap">
            {renaming ? (
              <input
                className="group-name-input session-rename-input session-context-rename"
                data-testid="session-rename-input"
                value={renameDraft}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") setRenaming(false);
                }}
                onBlur={commitRename}
              />
            ) : (
              <button
                ref={menuTriggerRef}
                type="button"
                className="session-current session-title-trigger"
                data-testid="session-menu"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-tooltip={`${HARNESS_LABELS[activeSession.harness]} · ${workspaceLabelOf(activeSession.cwd)} · ${activeSession.cwd}`}
                onClick={() => setMenuOpen((open) => !open)}
                {...trackingAttrs({ object: "session" })}
              >
                {busy ? (
                  <span
                    className="session-busy"
                    data-testid="session-busy"
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    className="session-dot"
                    data-status={activeSession.status}
                    aria-hidden="true"
                  />
                )}
                <span
                  className="session-context-title"
                  data-testid="session-context-title"
                >
                  {sessionName ?? activeSession.title}
                </span>
                <AssistantActivity assistant={assistant} sessionId={activeSession.id} />
                <Icon name="ChevronDown" size={13} />
              </button>
            )}
          </div>
        ) : (
          <span className="session-context-none">No active session</span>
        )}
      </div>

      {activeSession && (
        <AnchoredPopover
          open={menuOpen}
          anchorRef={menuTriggerRef}
          onDismiss={closeMenu}
          placement="down-start"
          className="session-menu"
          role="menu"
          testid="session-menu-popover"
        >
          {boundWorkflowName && (
            <div
              className="session-menu-bound"
              data-testid="session-workflow-chip"
            >
              Bound to <strong>{boundWorkflowName}</strong> · what this session
              is working on
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
      )}

      {actions}

      {onExpandRight && (
        <button
          ref={expandRightRef}
          className={
            "theme-toggle" +
            (showExpandRightLabel ? " right-expand-labeled" : "")
          }
          data-testid="right-expand"
          aria-label={expandRightLabel}
          title={expandRightLabel}
          onClick={onExpandRight}
        >
          <Icon name="PanelRightOpen" size={15} />
          {showExpandRightLabel && <span>{expandRightLabel}</span>}
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
