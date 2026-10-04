import { useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import type { HarnessSession, WorkflowInfo } from "@shared/types";

import { formatRelativeTime } from "../lib/history-meta";
import type { SessionMark } from "../lib/rail-sessions";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

/**
 * The agent, opened in place on the project's map (flow-navigation.md 4.4,
 * Q7): its name, where it lives with a Change action, its sessions, and
 * Start chat, floating over the map. Single click on the map opens this;
 * double click enters the agent's canvas, and Open canvas here is the same
 * move for a keyboard.
 *
 * This is where agents are managed now that the rail lists none (Q3). The ask
 * was "see my agents, and occasionally control the paths", so the path is the
 * second line, not buried in a menu, and changing it is one verb.
 */
export function MapAgentPanel({
  agent,
  sessions,
  sessionLabel,
  markOf,
  now,
  onOpenSession,
  onStartChat,
  startChatPending,
  onEnterCanvas,
  onChangeLocation,
  validateLocation,
  onClose,
}: {
  agent: WorkflowInfo;
  /** The agent's own sessions, in rail order (lib/rail-sessions). */
  sessions: readonly HarnessSession[];
  sessionLabel: (session: HarnessSession) => string;
  markOf: (session: HarnessSession) => SessionMark;
  now: number;
  onOpenSession: (id: string) => void;
  onStartChat: () => void;
  /** A Start chat is between create and bind; a second press would make two. */
  startChatPending: boolean;
  onEnterCanvas: () => void;
  /** Runs after the confirm, with the path the user typed. */
  onChangeLocation: (to: string) => void;
  /** Why a typed path cannot be the new location, or null when it can. */
  validateLocation: (to: string) => string | null;
  onClose: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.path);
  const [confirming, setConfirming] = useState<string | null>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  // A different agent picked while the field was open must not inherit the
  // previous agent's half-typed path.
  useEffect(() => {
    setEditing(false);
    setDraft(agent.path);
    setConfirming(null);
  }, [agent.path]);

  const trimmed = draft.trim().replace(/[\\/]+$/, "");
  const reason = trimmed === agent.path ? null : validateLocation(trimmed);
  const canMove = trimmed !== "" && trimmed !== agent.path && reason == null;
  const cancelEdit = (): void => {
    setEditing(false);
    setDraft(agent.path);
  };

  return (
    <aside
      className="map-agent-panel"
      data-testid="map-agent-panel"
      data-agent={agent.name}
      aria-label={agent.name}
      {...trackingAttrs({ object: "agent" })}
    >
      <div className="map-agent-panel-head">
        <Icon name="Zap" size={14} />
        <span className="map-agent-panel-name" data-testid="map-agent-panel-name">
          {agent.name}
        </span>
        <span className="map-agent-panel-state">
          {agent.definitionId != null ? "deployed" : "draft"}
        </span>
        <button
          type="button"
          className="theme-toggle map-agent-panel-close"
          data-testid="map-agent-panel-close"
          aria-label="Close"
          data-tooltip="Close"
          onClick={onClose}
        >
          <Icon name="X" size={14} />
        </button>
      </div>

      <section className="map-agent-section">
        <div className="map-agent-section-label">Location</div>
        {editing ? (
          <form
            className="map-agent-location-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canMove) setConfirming(trimmed);
            }}
          >
            <input
              className="map-agent-location-input"
              data-testid="map-agent-location-input"
              aria-label={`New location for ${agent.name}`}
              value={draft}
              autoFocus
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  cancelEdit();
                }
              }}
            />
            {reason && (
              <p
                className="map-agent-location-error"
                data-testid="map-agent-location-error"
                role="alert"
              >
                {reason}
              </p>
            )}
            <div className="map-agent-location-actions">
              <button
                type="button"
                className="btn-ghost"
                data-testid="map-agent-location-cancel"
                onClick={cancelEdit}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                data-testid="map-agent-location-submit"
                disabled={!canMove}
              >
                Move…
              </button>
            </div>
          </form>
        ) : (
          <div className="map-agent-location">
            <code
              className="map-agent-path"
              data-testid="map-agent-panel-path"
              title={agent.path}
            >
              {agent.path}
            </code>
            <button
              ref={changeRef}
              type="button"
              className="btn-line"
              data-testid="map-agent-change-location"
              onClick={() => setEditing(true)}
            >
              Change
            </button>
          </div>
        )}
      </section>

      <section className="map-agent-section">
        <div className="map-agent-section-label">Sessions</div>
        {sessions.length === 0 ? (
          <p className="map-agent-empty" data-testid="map-agent-sessions-empty">
            No sessions with this agent yet.
          </p>
        ) : (
          <div className="map-agent-sessions">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="map-agent-session"
                data-testid={`map-agent-session-${session.id}`}
                onClick={() => onOpenSession(session.id)}
                {...trackingAttrs({ object: "session" })}
              >
                <span
                  className="session-dot rail-session-mark"
                  data-mark={markOf(session)}
                  data-status={markOf(session) === "live" ? "running" : undefined}
                  aria-hidden="true"
                />
                <span className="map-agent-session-label">
                  {sessionLabel(session)}
                </span>
                <span className="rail-session-time">
                  {formatRelativeTime(
                    session.lastActiveAt ?? session.createdAt,
                    now,
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="map-agent-actions">
        <button
          type="button"
          className="btn-primary map-agent-start-chat"
          data-testid="map-agent-start-chat"
          aria-busy={startChatPending || undefined}
          disabled={startChatPending}
          onClick={onStartChat}
        >
          <Icon name="MessageSquare" size={14} /> Start chat
        </button>
        {/* The double click's twin, for a keyboard and for anyone who does
            not guess that a node can be entered. */}
        <button
          type="button"
          className="btn-line"
          data-testid="map-agent-open-canvas"
          data-tooltip={`Open ${agent.name}'s canvas`}
          onClick={onEnterCanvas}
        >
          Open canvas <Icon name="ChevronRight" size={12} />
        </button>
      </div>

      {confirming && (
        <ChangeLocationConfirm
          name={agent.name}
          from={agent.path}
          to={confirming}
          triggerRef={changeRef}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const to = confirming;
            setConfirming(null);
            setEditing(false);
            onChangeLocation(to);
          }}
        />
      )}
    </aside>
  );
}

/**
 * The one confirm before an agent's directory moves on disk. It names both
 * paths, because "move this agent?" with no destination on screen is the
 * accidental move the rail's drag used to make (flow-navigation.md 4.4.3).
 * Same anatomy as RemoveProjectConfirm: focus opens on the safe action, and
 * Escape or a backdrop click keep the agent where it is.
 */
function ChangeLocationConfirm({
  name,
  from,
  to,
  triggerRef,
  onCancel,
  onConfirm,
}: {
  name: string;
  from: string;
  to: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      role="alertdialog"
      className="modal-confirm"
      testId="change-location-confirm"
      title={`Move ${name}?`}
      onClose={onCancel}
      triggerRef={triggerRef}
      initialFocusRef={keepRef}
      actions={
        <>
          <button
            ref={keepRef}
            className="btn-ghost"
            data-testid="change-location-cancel"
            onClick={onCancel}
          >
            Keep it here
          </button>
          <button
            className="btn-primary"
            data-testid="change-location-confirm-move"
            onClick={onConfirm}
          >
            Move
          </button>
        </>
      }
    >
      <p className="modal-copy">
        This moves the agent's directory on disk. Sessions bound to it follow
        it.
      </p>
      <dl className="change-location-paths">
        <dt>From</dt>
        <dd>
          <code data-testid="change-location-old">{from}</code>
        </dd>
        <dt>To</dt>
        <dd>
          <code data-testid="change-location-new">{to}</code>
        </dd>
      </dl>
    </Dialog>
  );
}
