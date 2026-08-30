import { useEffect, useRef } from "react";
import type { JSX, RefObject } from "react";
import type { HarnessSession } from "@shared/types";

import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { HARNESS_LABELS } from "../lib/history-meta";
import { Icon } from "./Icon";

interface SessionTabsProps {
  sessions: HarnessSession[];
  activeSessionId: string | null;
  busySessionIds: ReadonlySet<string>;
  labelOf: (session: HarnessSession) => string;
  subjectName: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  newSessionPending: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  menuTriggerRef: RefObject<HTMLButtonElement | null>;
  menuTooltip?: string;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}

/**
 * Browser-style live-session switching for the focused agent or folder.
 *
 * The rail remains the project explorer. This strip owns session selection
 * and fresh same-folder creation; destructive session actions remain behind
 * the active tab's options menu rather than becoming per-tab close buttons.
 */
export function SessionTabs({
  sessions,
  activeSessionId,
  busySessionIds,
  labelOf,
  subjectName,
  onSelect,
  onNew,
  newSessionPending,
  menuOpen,
  onToggleMenu,
  menuTriggerRef,
  menuTooltip,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
}: SessionTabsProps): JSX.Element {
  const activeTabRef = useRef<HTMLDivElement>(null);
  const cancelRenameOnBlurRef = useRef(false);

  // A newly created session appends to the oldest-first list. Keep its tab in
  // view without moving the page or introducing a second header row.
  //
  // Also re-run when the STRIP's own width changes, not only when the list
  // does. The strip shares its row with the agent action cluster, which appears
  // and disappears with the selection — measured on the tab `+`, the strip is
  // 412px wide while the new session is still unbound and 191px once its
  // binding lands, and a tab scrolled into view against the wider box is
  // stranded outside the narrower one with nothing left to trigger a re-scroll.
  // A ResizeObserver is the honest dependency: the reason to scroll again is
  // that the viewport moved, not that the list changed.
  useEffect(() => {
    let frame = 0;
    const reveal = (): void => {
      activeTabRef.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
      // Once more after the next paint. A resize is reported in the same frame
      // the strip is re-laying out, so the tab's own box is still the old one
      // when the first call reads it — scrolling to a position the tab has
      // already left.
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() =>
        activeTabRef.current?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        }),
      );
    };
    reveal();
    const list = activeTabRef.current?.parentElement;
    if (!list) return;
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, sessions.length]);

  return (
    <div className="session-tabs" data-testid="session-tabs">
      <div className="session-tabs-list" role="tablist" aria-label="Sessions">
        {sessions.map((session) => {
          const active = session.id === activeSessionId;
          const label = labelOf(session);
          const provider = HARNESS_LABELS[session.harness];
          const showRename = active && renaming;

          return (
            <div
              ref={active ? activeTabRef : undefined}
              key={session.id}
              className={`session-tab${active ? " is-active" : ""}`}
              data-testid={`session-tab-${session.id}`}
            >
              {showRename ? (
                <input
                  className="group-name-input session-rename-input session-tab-rename"
                  data-testid="session-rename-input"
                  aria-label="Rename session"
                  value={renameDraft}
                  autoFocus
                  onFocus={(event) => {
                    cancelRenameOnBlurRef.current = false;
                    event.currentTarget.select();
                  }}
                  onChange={(event) => onRenameDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onCommitRename();
                    if (event.key === "Escape") {
                      cancelRenameOnBlurRef.current = true;
                      onCancelRename();
                    }
                  }}
                  onBlur={() => {
                    if (cancelRenameOnBlurRef.current) {
                      cancelRenameOnBlurRef.current = false;
                      return;
                    }
                    onCommitRename();
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="session-tab-main"
                  data-testid={`session-tab-main-${session.id}`}
                  title={`${label} · ${provider}`}
                  data-tooltip={`${label} · ${provider}`}
                  onClick={() => onSelect(session.id)}
                >
                  {busySessionIds.has(session.id) ? (
                    <span
                      className="session-busy"
                      data-testid={`session-tab-busy-${session.id}`}
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className="session-dot"
                      data-status={session.status}
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className="session-tab-label"
                    data-testid={active ? "session-context-title" : undefined}
                  >
                    {label}
                  </span>
                </button>
              )}

              {active && !showRename && (
                <button
                  ref={menuTriggerRef}
                  type="button"
                  className="theme-toggle session-tab-menu"
                  data-testid="session-menu"
                  aria-label="Session options"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  data-tooltip={menuTooltip}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleMenu();
                  }}
                  {...trackingAttrs({ object: "session" })}
                >
                  <Icon name="ChevronDown" size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="theme-toggle session-tab-new"
        data-testid="session-tab-new"
        aria-label={`New session on ${subjectName}`}
        aria-busy={newSessionPending}
        data-tooltip={`New session on ${subjectName}`}
        disabled={newSessionPending}
        onClick={onNew}
      >
        {newSessionPending ? (
          <span className="session-busy" aria-hidden="true" />
        ) : (
          <Icon name="Plus" size={14} />
        )}
      </button>
    </div>
  );
}
