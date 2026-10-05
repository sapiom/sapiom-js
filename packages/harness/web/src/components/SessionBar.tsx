import { AssistantActivity } from "./AssistantActivity";
import type { AssistantProjection } from "../lib/assistant-state";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { HarnessSession } from "@shared/types";

import { HARNESS_LABELS } from "../lib/history-meta";
import { basenameOf } from "../lib/paths";
import type { ToastTone } from "../lib/toast";
import { AnchoredPopover } from "./AnchoredPopover";
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
  /** Ends a live session at once, no confirm (flow-map-chat-overlay.md 4.5):
   *  kills its PTY; the row stays, exited, and resumable from history. */
  onCloseSession: (id: string) => void;
  /** Opens the session's directory in the user's editor. */
  onOpenInEditor: (path: string) => void;
  /** The chosen editor's display name, so the item names where it lands. */
  editorLabel: string;
  /** Push a message onto the app's toast rail. Defaults to the "error" tone;
   *  result announcements opt into "info". */
  onToast: (message: string, tone?: ToastTone) => void;
  /**
   * Set while a project's Agent Map (or an agent's canvas entered from it) is
   * the centre (flow-navigation.md 4.3, 4.4). The header reads
   * `project · Agent Map`, or `← project · agent` with the way back, and
   * carries New agent (Q11), over the agents it adds to.
   */
  projectView?: ProjectViewHeader | null;
}

export interface ProjectViewHeader {
  label: string;
  /** The agent whose canvas was entered from the map, if any. */
  agentName: string | null;
  onBackToMap: () => void;
  onNewAgent: () => void;
  /** Full view for a drawn map; null when there is no map to enlarge. */
  onExpandMap: (() => void) | null;
}

/**
 * The single main-panel header. The rail is the session switcher now
 * (flow-navigation.md Q2), so there is no tab strip: the header names the
 * session on screen, and its title IS the session's options menu (Copy path /
 * Rename / Open in editor / End session), live or exited alike. No agent
 * verbs beside a session: agent detail is the project view's
 * (flow-map-chat-overlay.md 4.4.1).
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
  onCloseSession,
  onOpenInEditor,
  editorLabel,
  onToast,
  projectView = null,
}: SessionBarProps): JSX.Element {
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
        {projectView ? (
          /* A project is selected: the centre is its Agent Map, or an agent's
             canvas entered from it, with the way back. */
          <div className="session-current session-current-static">
            {projectView.agentName ? (
              <button
                type="button"
                className="theme-toggle project-map-back"
                data-testid="project-map-back"
                aria-label={`Back to ${projectView.label}'s Agent Map`}
                data-tooltip="Back to the Agent Map"
                onClick={projectView.onBackToMap}
              >
                <Icon name="ArrowLeft" size={14} />
              </button>
            ) : (
              <Icon name="Waypoints" size={14} />
            )}
            <span
              className="session-context-title"
              data-testid="session-context-title"
            >
              {projectView.label}
            </span>
            {projectView.agentName ? (
              <span
                className="session-project-chip"
                data-testid="session-map-agent-chip"
              >
                {projectView.agentName}
              </span>
            ) : (
              <span
                className="session-project-chip"
                data-testid="session-project-map-chip"
              >
                Agent Map
              </span>
            )}
          </div>
        ) : overviewMode ? (
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
                onCloseSession(activeSession.id);
              }}
            >
              <Icon name="X" size={13} />
              End session
            </button>
          )}
        </AnchoredPopover>
      )}

      {projectView && (
        <div className="project-view-actions">
          {/* New agent, in the project view's header (Q11): the map is where
              a project's agents are, so the verb that adds one sits over it. */}
          <button
            type="button"
            className="btn-line project-map-new-agent"
            data-testid="project-map-new-agent"
            data-tooltip={`New agent in ${projectView.label}`}
            onClick={projectView.onNewAgent}
          >
            <Icon name="Plus" size={13} /> New agent
          </button>
          {projectView.onExpandMap && (
            <button
              type="button"
              className="theme-toggle"
              data-testid="canvas-expand"
              aria-label="Expand Agent Map"
              title="Expand Agent Map"
              onClick={projectView.onExpandMap}
            >
              <Icon name="Maximize2" size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
