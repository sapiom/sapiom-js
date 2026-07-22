import { useRef, useState } from "react";
import type { JSX } from "react";
import type { HarnessSession } from "@shared/types";

import { HARNESS_LABELS } from "../lib/history-meta";
import { EndSessionConfirm } from "./EndSessionConfirm";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { Icon } from "./Icon";

interface SessionTabsProps {
  /** The focused agent's live sessions, oldest-first — the tab order, and the
   *  order Cmd/Ctrl+1..9 selects. */
  sessions: HarnessSession[];
  activeSessionId: string | null;
  /** Sessions streaming output in the last few seconds — their tab swaps the
   *  live dot for the busy pulse (only meaningful on a non-active tab). */
  busySessionIds: Set<string>;
  /** Display name for a tab (rename > transcript title > folder basename). */
  labelOf: (session: HarnessSession) => string;
  /** The focused agent's name — the + tab's accessible name and tooltip. */
  agentName: string;
  onSelect: (id: string) => void;
  /** Ends a tab's session once the confirm is accepted; App handles the
   *  active-tab fallback. */
  onClose: (id: string) => void;
  /** Opens a new session on the focused agent (the trailing +). */
  onNew: () => void;
}

/**
 * The main panel's session tab strip: one tab per live session belonging to
 * the FOCUSED agent. This is where session SWITCHING lives now —
 * the rail is a pure explorer of agents, the session bar is the active
 * session's identity header. Anatomy per tab: [agent-kind brand icon][name]
 * [live/busy dot][× close]. A trailing + opens another session on the agent.
 */
export function SessionTabs({
  sessions,
  activeSessionId,
  busySessionIds,
  labelOf,
  agentName,
  onSelect,
  onClose,
  onNew,
}: SessionTabsProps): JSX.Element {
  // Ending a tab kills a real PTY, so the × opens the shared confirm first.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Captures the × that opened the confirm so Escape hands focus back to it.
  const lastCloseTrigger = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="session-tabs" role="tablist" aria-label="Sessions" data-testid="session-tabs">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        const busy = busySessionIds.has(session.id);
        const label = labelOf(session);
        return (
          <div
            key={session.id}
            className={"session-tab" + (isActive ? " is-active" : "")}
            data-testid={`session-tab-${session.id}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className="session-tab-main"
              data-testid={`session-tab-main-${session.id}`}
              title={`${label} · ${HARNESS_LABELS[session.harness]}`}
              onClick={() => onSelect(session.id)}
            >
              <HarnessBrandIcon kind={session.harness} size={13} />
              <span className="session-tab-label">{label}</span>
              {busy ? (
                <span className="session-tab-busy" data-testid={`session-tab-busy-${session.id}`} aria-hidden="true" />
              ) : (
                <span className="session-tab-dot" data-status={session.status} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="session-tab-close"
              data-testid={`session-tab-close-${session.id}`}
              aria-label={`Close ${label}`}
              data-tooltip="End session"
              onClick={(e) => {
                lastCloseTrigger.current = e.currentTarget;
                setConfirmingId(session.id);
              }}
            >
              <Icon name="X" size={12} />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        className="session-tab-new"
        data-testid="session-tab-new"
        aria-label={`New session on ${agentName}`}
        data-tooltip="New session on this agent"
        onClick={onNew}
      >
        <Icon name="Plus" size={14} />
      </button>

      {confirmingId && (
        <EndSessionConfirm
          triggerRef={lastCloseTrigger}
          onCancel={() => setConfirmingId(null)}
          onConfirm={() => {
            const id = confirmingId;
            setConfirmingId(null);
            onClose(id);
          }}
        />
      )}
    </div>
  );
}
