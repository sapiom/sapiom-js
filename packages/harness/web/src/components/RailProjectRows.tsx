import type { JSX, ReactNode } from "react";

import { projectInitial } from "../lib/project-tree";
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
