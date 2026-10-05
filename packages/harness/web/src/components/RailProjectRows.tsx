import type { JSX, ReactNode } from "react";
import type { HarnessSession } from "@shared/types";

import { HARNESS_LABELS, formatRelativeTime } from "../lib/history-meta";
import { projectInitial } from "../lib/project-tree";
import type { SessionMark } from "../lib/rail-sessions";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { Icon } from "./Icon";

/**
 * Collapse keys are NAMESPACED, so a stored key from the old rail (which also
 * folded directories, `dir:`) can never fold a project by accident.
 */
export const projectKey = (root: string): string => `project:${root}`;

/**
 * The row's left slot: identity at rest, disclosure on hover.
 *
 * The icon you already look at IS the control: hover the row and the mark
 * becomes a chevron in place. Zero extra width, and the affordance appears
 * exactly where the pointer already is. Both children stay mounted and swap by
 * CSS, so the slot never changes size and the row cannot reflow under the
 * cursor. A COLLAPSED row shows its chevron unhovered: "there is more here"
 * must never be invisible.
 */
function RowDisclosure({
  collapsed,
  onToggle,
  label,
  testid,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
  testid?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className="row-disclosure"
      data-testid={testid}
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      data-tooltip={collapsed ? "Expand" : "Collapse"}
    >
      <span className="row-disclosure-mark" aria-hidden="true">
        {children}
      </span>
      <span className="row-disclosure-chevron" aria-hidden="true">
        <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={13} />
      </span>
    </button>
  );
}

/**
 * A project's header row in the rail (flow-navigation.md 4.1): mark, name,
 * and the trailing `+` that starts a new chat in it (Q11).
 *
 * The NAME selects the project, which puts its Agent Map in the centre at full
 * width (4.3); the mark slot is the fold. Two highlights, because every
 * project is expanded at once and the eye still has to find "where am I":
 * `selected` is the full fill (its map is the centre), `holdsSelection` is the
 * quieter one (the selected session lives under it). Without the quiet one, a
 * rail of five expanded projects loses which project you are in, the "project
 * separation should still be clear" half of the ask.
 *
 * The letter is DERIVED from the folder name, never fetched: GitHub serves an
 * auto-generated identicon for an org with no avatar, which renders as though
 * it were a logo, and a guessed logo is worse than an honest initial.
 */
export function ProjectRow({
  label,
  root,
  collapsed,
  onToggleCollapsed,
  selected,
  holdsSelection,
  onSelect,
  tooltip,
  trailing,
}: {
  label: string;
  root: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The project's Agent Map is the centre. */
  selected: boolean;
  /** The selected session is one of this project's rows. */
  holdsSelection: boolean;
  onSelect: () => void;
  tooltip?: string;
  /** Row-end slot for actions that belong to the PROJECT. */
  trailing?: ReactNode;
}): JSX.Element {
  const quiet = holdsSelection && !selected;
  return (
    <div
      className={
        "workspace-row rail-project-row" +
        (selected ? " is-selected" : "") +
        (quiet ? " holds-selection" : "") +
        (collapsed ? " is-collapsed" : "")
      }
      data-testid={`workspace-group-${label}`}
      data-selected={selected || undefined}
      data-holds-selection={quiet || undefined}
      {...trackingAttrs({ object: "workspace" })}
    >
      <RowDisclosure
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
        label={label}
        testid={`project-disclosure-${label}`}
      >
        <span className="project-mark" aria-hidden="true">
          {projectInitial(root)}
        </span>
      </RowDisclosure>
      <button
        type="button"
        className="workspace-row-main"
        data-testid={`project-select-${label}`}
        onClick={onSelect}
        /* Double-click folds, the platform convention for a disclosure row.
           The two single clicks underneath select an already-selected
           project, which is the same state twice, so only the fold changes
           anything. */
        onDoubleClick={onToggleCollapsed}
        title={root}
        aria-pressed={selected}
        aria-label={`Open Agent Map for ${label}`}
        data-tooltip={
          tooltip ?? (selected ? "Agent Map selected" : "Open Agent Map")
        }
      >
        <span className="tree-row-label">{label}</span>
      </button>
      {trailing}
    </div>
  );
}

const MARK_TITLE: Record<SessionMark, string> = {
  live: "Live: the agent is working",
  idle: "Idle: running, quiet for a while",
  exited: "Exited: the process ended",
};

/**
 * One session under its project (flow-navigation.md 4.1.2): its name, a
 * live/idle/exited mark, and when it was last active. One click selects it
 * from anywhere in the rail, which is the whole ask: "it should take one
 * click to go from one to the other".
 *
 * The trailing `×` means two things, both said in its label: on a live row it
 * ENDS the session at once (no confirm, flow-map-chat-overlay.md 4.5), on an
 * exited row it HIDES the row (History keeps it). Q4 settled that close and
 * end stay one action,
 * and a row with no process behind it has nothing left to end.
 */
export function SessionRow({
  session,
  name,
  mark,
  agentName,
  selected,
  onSelect,
  onClose,
  now,
}: {
  session: HarnessSession;
  name: string;
  mark: SessionMark;
  /** The agent this session is bound to, when it is. */
  agentName: string | null;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  now: number;
}): JSX.Element {
  const exited = mark === "exited";
  return (
    <div
      className={
        "workspace-row is-nested rail-session-row" +
        (selected ? " is-selected" : "")
      }
      data-testid={`rail-session-${session.id}`}
      data-mark={mark}
      data-agent={agentName ?? undefined}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        className="tree-row rail-session-main"
        data-testid={`rail-session-select-${session.id}`}
        aria-current={selected ? "true" : undefined}
        title={`${HARNESS_LABELS[session.harness]} · ${session.cwd}${agentName ? ` · ${agentName}` : ""}`}
        onClick={onSelect}
        {...trackingAttrs({ object: "session" })}
      >
        <span
          className="session-dot rail-session-mark"
          data-mark={mark}
          /* The dot recipe's running state carries the green, so one dot
             means one thing across the app. */
          data-status={mark === "live" ? "running" : undefined}
          data-testid={`rail-session-mark-${session.id}`}
          role="img"
          aria-label={MARK_TITLE[mark]}
          data-tooltip={MARK_TITLE[mark]}
        />
        <span className="tree-row-label">{name}</span>
        <span
          className="rail-session-time"
          data-testid={`rail-session-time-${session.id}`}
        >
          {formatRelativeTime(session.lastActiveAt ?? session.createdAt, now)}
        </span>
      </button>
      <button
        type="button"
        className="workspace-row-action rail-session-close"
        data-testid={`rail-session-close-${session.id}`}
        aria-label={exited ? `Hide ${name} from the rail` : `End ${name}`}
        data-tooltip={
          exited ? "Hide from the rail (History keeps it)" : "End session"
        }
        onClick={onClose}
      >
        <Icon name="X" size={13} />
      </button>
    </div>
  );
}
