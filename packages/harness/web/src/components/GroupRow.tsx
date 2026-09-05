import { useRef, useState } from "react";
import type { CSSProperties, DOMAttributes, JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";
import { LiveMark, RowDisclosure } from "./ProjectTreeRows";
import { WorkflowRow } from "./WorkflowRow";
import type { GroupNode } from "../lib/agent-groups";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { liveSessionsOnAgents } from "../lib/project-live";
import type { ScopedSession } from "../lib/session-scope";

/**
 * The drag payload rides in `dataTransfer`, NOT in component state.
 *
 * `dragstart` and `drop` can land in the same tick, and a state-held payload
 * reads as `null` exactly when the drop needs it. Two entries: the agent's
 * absolute path, and the group it was dragged OUT of — a move has to know what
 * to leave, and "which row did this start on" is not recoverable at drop time
 * from the path alone (one agent may sit in several groups).
 *
 * `getData` is deliberately blank during `dragover` (the spec's protected mode),
 * so the hover highlight keys on `types` and only the drop reads values.
 */
export const DRAG_AGENT_TYPE = "application/x-sapiom-agent";
export const DRAG_GROUP_TYPE = "application/x-sapiom-group";

export interface GroupRowProps {
  label: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /**
   * Ungrouped is the ABSENCE of membership — derived on every render, never
   * stored. Renaming it would name something that is not there, and deleting it
   * would promise to remove agents that are only in it because nothing claims
   * them. Both affordances drop entirely rather than being disabled: a
   * greyed-out control still says "this is a thing you could do here".
   */
  isUngrouped?: boolean;
  /** How many live sessions this group's members hold, for the standing live
   *  mark (SAP-3200). A group header is a header like the project row is, and it
   *  answers the same at-a-glance question about the agents under it. Counted by
   *  the SECTION rather than here: the row has no sessions of its own, and the
   *  membership rule belongs with the model. */
  liveCount?: number;
  /** True while this row is the drop target. Owned by the section, not the row:
   *  rows that each track their own hover disagree mid-drag. */
  isDropTarget?: boolean;
  /** Absent = this group cannot be renamed (no pencil, no double-click). */
  onRename?: (label: string) => void;
  /** Absent = this group cannot be deleted. */
  onDelete?: () => void;
  /**
   * Mount straight into the input. A group is created BEFORE it is named, so
   * without this the user's first sight of it is the placeholder label — the
   * exact "every group reads New group" problem naming is meant to solve. Read
   * once, at mount; changing it later does nothing, which is why the caller
   * keys the row on it.
   */
  startRenaming?: boolean;
  /** Row tooltip. Left to the caller: "and everything it launches" is true of a
   *  detected group and a lie about one someone made by hand. */
  title?: string;
  /** Drop handlers from the section. The row renders the state; what a drop
   *  MEANS (move vs. copy) lives with the model. */
  dropHandlers?: DOMAttributes<HTMLDivElement>;
}

/**
 * A group header on the GROUP axis.
 *
 * A group names a relationship, so this row carries no path actions — there is
 * no directory behind it to copy or reveal, and offering one would imply the
 * cluster lives somewhere on disk. What it does carry is the two things a label
 * needs and a directory does not: a way to say what it is called, and a way to
 * stop calling it that. Both change nothing on disk; a group is a label over
 * agents.
 *
 * The left icon is the disclosure control, the same single idiom every other row
 * in the rail uses (`RowDisclosure`). A second disclosure affordance here would
 * be a regression.
 */
export function GroupRow({
  label,
  collapsed,
  onToggleCollapsed,
  isUngrouped = false,
  liveCount = 0,
  isDropTarget = false,
  onRename,
  onDelete,
  startRenaming = false,
  title,
  dropHandlers,
}: GroupRowProps): JSX.Element {
  const canRename = onRename != null && !isUngrouped;
  const canDelete = onDelete != null && !isUngrouped;

  /**
   * `null` is "not editing". Holding the draft and the mode in ONE value is what
   * stops the two from disagreeing — an open input with no draft, or a stale
   * draft that reappears the next time you rename.
   */
  const [draft, setDraft] = useState<string | null>(startRenaming && canRename ? label : null);
  const editing = draft !== null && canRename;

  /**
   * Blur commits, so this runs on every way out except Escape. An empty or
   * whitespace-only name is DISCARDED rather than stored: a nameless row is
   * unreadable, and reaching it by clicking away — the one gesture that expects
   * nothing to happen — would leave a row you cannot find in order to fix it. An
   * unchanged name is discarded too, so tabbing through never writes.
   */
  const commit = (): void => {
    const next = (draft ?? "").trim();
    setDraft(null);
    if (next !== "" && next !== label) onRename?.(next);
  };

  const inputRef = useRef<HTMLInputElement | null>(null);
  /** The user has typed, so a blur is theirs and the draft is worth keeping. */
  const typed = useRef(false);
  /** One un-earned blur has already been forgiven this rename. */
  const forgaveBlur = useRef(false);

  const beginRename = (): void => {
    typed.current = false;
    forgaveBlur.current = false;
    setDraft(label);
  };

  /**
   * A blur the input never earned is ignored ONCE, by taking focus back.
   *
   * Creating a group closes the create affordance, which restores focus to its
   * trigger — blurring this input in the same breath as it mounted. Committing
   * there discarded the unchanged name and closed the field, so the row appeared
   * already called "New group" and the user never saw the input they had just
   * asked for. Deferring the mount a frame only moves the race: the focus
   * restore comes from an effect that can land later.
   *
   * So the rule is about PROVENANCE, not timing. Before the first keystroke
   * there is nothing to commit — an unchanged draft is discarded either way — so
   * the only question is whether the field stays open, and taking focus back
   * answers it without guessing when the steal happens. Exactly one blur is ever
   * forgiven, and never after a keystroke, so a user who types and clicks away
   * commits immediately and focus can never ping-pong. The cost is that clicking
   * away from an untouched field bounces once before it closes.
   */
  const onInputBlur = (): void => {
    if (!typed.current && !forgaveBlur.current) {
      forgaveBlur.current = true;
      inputRef.current?.focus();
      return;
    }
    commit();
  };

  return (
    <div
      /* `is-nested` at depth 0, exactly like a directory row: a group is a row
         INSIDE a project, so indent alone carries the nesting and the project's
         single hairline guide already runs the height of the subtree. Without it
         the group sat at the project row's own indent and the two read as
         siblings. */
      className={
        "workspace-row is-nested" +
        (collapsed ? " is-collapsed" : "") +
        (isDropTarget ? " is-drop-target" : "")
      }
      style={{ "--tree-depth": 0 } as CSSProperties}
      data-testid={`group-row-${label}`}
      {...trackingAttrs({ object: "workspace" })}
      {...dropHandlers}
    >
      <RowDisclosure
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
        label={label}
        testid={`group-disclosure-${label}`}
      >
        {/* Ungrouped takes the folder glyph and a real group the workflow one:
            one is a bucket, the other is a system. */}
        <Icon name={isUngrouped ? "Folder" : "Workflow"} size={13} />
      </RowDisclosure>

      {editing ? (
        /* Escape clears the draft, which unmounts this input — and an unmounted
           input's onBlur never fires, so cancel cannot fall through to commit. */
        <input
          ref={inputRef}
          className="group-name-input"
          data-testid="group-rename-input"
          aria-label={`Rename ${label}`}
          value={draft ?? ""}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            typed.current = true;
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(null);
          }}
          onBlur={onInputBlur}
        />
      ) : (
        <button
          type="button"
          className="workspace-row-main"
          onClick={onToggleCollapsed}
          /* Double-click renames; a single click keeps toggling disclosure,
             because that is what every other row in the rail does and because a
             rename you can enter by brushing the label is one you enter by
             accident. The two clicks underneath toggle twice and cancel out. */
          onDoubleClick={canRename ? beginRename : undefined}
          aria-expanded={!collapsed}
          title={title}
          data-tooltip={title}
        >
          <span className="tree-row-label">{label}</span>
        </button>
      )}

      {/* LIVE, at a glance (SAP-3200, D37): a member has a running session.
          Ahead of the hover actions, and outside the editing guard below, so the
          fact stays true while the row is being renamed; it is not an action a
          stray click could fire. */}
      <LiveMark count={liveCount} testId={`group-live-${label}`} />

      {/* Hidden while editing: the input owns the row's width, and clicking an
          action would blur-commit and act in one gesture. */}
      {canRename && !editing && (
        <button
          type="button"
          className="workspace-row-action"
          data-testid={`group-rename-${label}`}
          aria-label={`Rename ${label}`}
          data-tooltip="Rename group"
          onClick={beginRename}
        >
          <Icon name="Pencil" size={13} />
        </button>
      )}
      {canDelete && !editing && (
        <button
          type="button"
          className="workspace-row-action"
          data-testid={`group-delete-${label}`}
          aria-label={`Delete ${label}`}
          data-tooltip="Delete group. Nothing is removed from disk."
          onClick={onDelete}
        >
          <Icon name="Trash2" size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * An agent row inside a group, made draggable.
 *
 * A thin host around `WorkflowRow` rather than a second agent-row component:
 * the row anatomy — the immediate-parent prefix, the one flex unit, the `/`
 * outside the truncating span — was arrived at by rendering it and watching it
 * fail, and a copy would drift from those three rules the first time either side
 * is touched. The host exists only to carry `draggable` and the payload.
 */
export function GroupAgentRow({
  workflow,
  prefix = "",
  prefixFull = "",
  groupId,
  isFocused,
  onFocus,
  draggable = true,
}: {
  workflow: WorkflowInfo;
  /**
   * The disambiguating parent chain, from `project-tree.agentPrefixes`.
   *
   * The Group axis has no directory rows, so an agent row here is the WHOLE
   * answer to "which agent is this". Round 1 passed none, and two agents named
   * `ads` in one project rendered as two identical rows inside `Ungrouped` —
   * the same failure the unrooted section had, one axis over.
   */
  prefix?: string;
  prefixFull?: string;
  /** The group this row is being dragged OUT of — a move needs to know what to
   *  leave, and one agent may sit in several groups. */
  groupId: string;
  isFocused: boolean;
  onFocus: (path: string) => void;
  /** False before the project's stored arrangement has loaded: a drop cannot be
   *  applied to a file that has not arrived. */
  draggable?: boolean;
}): JSX.Element {
  return (
    <div
      className="group-agent-drag"
      draggable={draggable}
      data-testid={`group-agent-${workflow.name}`}
      onDragStart={(event) => {
        if (!draggable) return;
        // copyMove, not move: Option-drag COPIES, which is the shared-subagent
        // case, and a source that only allows "move" makes the browser refuse
        // the copy cursor.
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData(DRAG_AGENT_TYPE, workflow.path);
        event.dataTransfer.setData(DRAG_GROUP_TYPE, groupId);
      }}
    >
      {/* Depth 1: one level under its group row, which sits at depth 0 — the
          same project/directory/agent rhythm the Project axis reads with. */}
      <WorkflowRow
        workflow={workflow}
        prefix={prefix}
        prefixFull={prefixFull}
        isFocused={isFocused}
        onFocus={onFocus}
        depth={1}
      />
    </div>
  );
}

/** What a drop resolved to, handed up to the rail (which owns the model). */
export interface GroupDropRequest {
  path: string;
  fromGroupId: string;
  toGroupId: string;
  /** Option/Alt held: copy instead of move. */
  copy: boolean;
}

/**
 * One project's group list: the group rows, their agents, and the create row.
 *
 * PER PROJECT, because groups are project-scoped and cannot span projects — the
 * arrangement lives in that project's `.sapiom/`, which is what makes it
 * committable and shareable, and there is no file a cross-project group could
 * live in. It also settles what "create a group" means: the create row sits at
 * the end of the list it creates into, in one project.
 *
 * The drop target is the whole SECTION rather than the header row alone, so
 * dropping onto the agents under a group means what it looks like it means. One
 * `dropTarget` per section: only one section can hold the pointer, and rows that
 * each tracked their own hover disagreed mid-drag.
 */
export function GroupSections({
  sectionLabel,
  groups,
  prefixes,
  editable,
  isDerived,
  freshLabel,
  collapsedKeys,
  onToggleCollapsed,
  focusedAgentPath,
  onFocusAgent,
  sessions,
  onCreate,
  onRename,
  onDelete,
  onDrop,
  onReset,
  resetCount,
}: {
  /** The project's label, so testids and aria copy name a project a user can
   *  see rather than an absolute path. */
  sectionLabel: string;
  groups: GroupNode[];
  /** Disambiguating parent chains by agent path, from
   *  `project-tree.agentPrefixes` — the rail computes them once per project,
   *  over ALL the project's agents, because a collision between two rows is a
   *  fact about the project and not about the group either of them is in. */
  prefixes?: ReadonlyMap<string, { prefix: string; prefixFull: string }>;
  /** False until this project's stored arrangement has loaded. Edit affordances
   *  are ABSENT rather than disabled while it has not: a control that silently
   *  does nothing reads as broken. */
  editable: boolean;
  /** True while nothing is stored. Only then is "and everything it launches" a
   *  true claim about a group's membership. */
  isDerived: boolean;
  /** The label of the group created by the last "New group" press, so its row
   *  mounts into the rename input. */
  freshLabel: string | null;
  collapsedKeys: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  focusedAgentPath: string | null;
  onFocusAgent: (path: string) => void;
  /** Every session the rail knows about, so each header can count its own live
   *  ones. Structurally typed (`ScopedSession`), like the rules in
   *  `session-scope.ts`, so a test can pin a header with an object literal. */
  sessions: readonly ScopedSession[];
  onCreate: () => void;
  onRename: (groupId: string, label: string) => void;
  onDelete: (groupId: string) => void;
  onDrop: (request: GroupDropRequest) => void;
  /** Absent = this project's arrangement is still DERIVED, so there is nothing
   *  to hand back and the control would do nothing. A control that does nothing
   *  reads as a broken one. */
  onReset?: () => void;
  /** How many stored groups the reset would discard — the cost, stated in the
   *  copy rather than paid for by hiding the control. */
  resetCount: number;
}): JSX.Element {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** The reset is armed by the first click and performed by the second: it
   *  discards work, and the armed label is where the cost is stated. */
  const [resetArmed, setResetArmed] = useState(false);

  const dropHandlersFor = (groupId: string): DOMAttributes<HTMLDivElement> => ({
    onDragOver: (event) => {
      // `types` is readable in protected mode; `getData` is not. The highlight
      // therefore keys on "an agent is being dragged", and only the drop reads
      // which one.
      if (!event.dataTransfer.types.includes(DRAG_AGENT_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
      if (dropTarget !== groupId) setDropTarget(groupId);
    },
    onDragLeave: (event) => {
      // Moving between a section's own children fires dragleave too; only a
      // pointer that has actually left the section clears the highlight.
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropTarget((prev) => (prev === groupId ? null : prev));
    },
    onDrop: (event) => {
      if (!event.dataTransfer.types.includes(DRAG_AGENT_TYPE)) return;
      event.preventDefault();
      setDropTarget(null);
      onDrop({
        path: event.dataTransfer.getData(DRAG_AGENT_TYPE),
        fromGroupId: event.dataTransfer.getData(DRAG_GROUP_TYPE),
        toGroupId: groupId,
        copy: event.altKey,
      });
    },
  });

  return (
    <>
      {groups.map((group) => {
        const collapsed = collapsedKeys.has(group.id);
        const fresh = editable && group.label === freshLabel;
        return (
          <div
            /* The fresh flag rides in the KEY so the row remounts the moment it
               becomes the newly-created one. `startRenaming` is read once at
               mount, and the row can mount a render before the fresh label
               lands — keying on it makes the mount that reads the prop the one
               that sees it true. */
            key={group.id + (fresh ? ":fresh" : "")}
            className="workspace-group workspace-subgroup"
            data-testid={`group-section-${group.label}`}
            {...dropHandlersFor(group.id)}
          >
            <GroupRow
              label={group.label}
              collapsed={collapsed}
              onToggleCollapsed={() => onToggleCollapsed(group.id)}
              isUngrouped={group.isUngrouped}
              liveCount={
                liveSessionsOnAgents(
                  sessions,
                  group.agents.map((agent) => agent.workflow.path),
                ).length
              }
              isDropTarget={dropTarget === group.id}
              startRenaming={fresh}
              /* The launch claim is only true of a DETECTED group. Once the
                 arrangement is the user's, "and everything it launches" would
                 assert a derivation that no longer governs the membership. */
              title={
                group.isUngrouped
                  ? "No launch edge reaches these agents"
                  : isDerived
                    ? `${group.label} and everything it launches`
                    : undefined
              }
              onRename={
                editable && !group.isUngrouped
                  ? (label) => onRename(group.id, label)
                  : undefined
              }
              onDelete={
                editable && !group.isUngrouped ? () => onDelete(group.id) : undefined
              }
            />
            {!collapsed &&
              group.agents.map((agent) => (
                <GroupAgentRow
                  key={agent.workflow.path}
                  workflow={agent.workflow}
                  prefix={prefixes?.get(agent.workflow.path)?.prefix ?? ""}
                  prefixFull={prefixes?.get(agent.workflow.path)?.prefixFull ?? ""}
                  groupId={group.id}
                  isFocused={agent.workflow.path === focusedAgentPath}
                  onFocus={onFocusAgent}
                  draggable={editable}
                />
              ))}
            {!collapsed && group.agents.length === 0 && (
              /* A group with no members is not a mistake — a new group is
                 populated by dragging agents into it, so the row has to say what
                 to do rather than look like a rendering failure. */
              <div
                className="workspace-group-empty"
                style={{ paddingLeft: "calc(2 * var(--tree-indent))" } as CSSProperties}
              >
                Drag agents here
              </div>
            )}
          </div>
        );
      })}

      {/* CREATE, in the list it creates into.
          In the prototype this lived in the settings panel, where nobody found
          it — someone went looking for a way to make a group and concluded the
          feature did not exist. A create action belongs at the END of the thing
          it extends, where the eye already is after reading the list, and
          visible at rest rather than on hover, because a list you cannot add to
          reads as a fixed list. */}
      {editable && (
        <button
          type="button"
          className="rail-add-row"
          data-testid={`group-create-${sectionLabel}`}
          aria-label={`New group in ${sectionLabel}`}
          onClick={() => {
            setResetArmed(false);
            onCreate();
          }}
        >
          <Icon name="Plus" size={13} />
          <span className="tree-row-label">New group</span>
        </button>
      )}

      {/* THE WAY BACK. Detection seeds the groups; the first edit takes them
          over, and that is a ONE-WAY door — "the user deleted every group" must
          not be re-read as "detect again", or a reload would undo the deletion.
          Which leaves an arrangement you regret as one you are stuck with:
          delete every group and the axis shows one flat Ungrouped list forever,
          which reads as the feature being broken rather than a state you chose.
          So the reset is offered whenever groups are STORED, including when they
          hold real work — a reset that only appeared once you had deleted
          everything would ask people to destroy their groups to find it. The
          cost goes in the copy, not into hiding the control. */}
      {editable && onReset && (
        <button
          type="button"
          className={"rail-add-row rail-reset-row" + (resetArmed ? " is-armed" : "")}
          data-testid={`group-reset-${sectionLabel}`}
          aria-label={
            resetArmed
              ? `Confirm resetting ${sectionLabel} to detected groups`
              : `Reset ${sectionLabel} to detected groups`
          }
          onClick={() => {
            if (!resetArmed) {
              setResetArmed(true);
              return;
            }
            setResetArmed(false);
            onReset();
          }}
          onBlur={() => setResetArmed(false)}
        >
          <Icon name="RefreshCw" size={13} />
          {/* Short enough to survive the rail's width beside the cost. The full
              sentence lives in the aria-label, where it has room. */}
          <span className="tree-row-label">
            {resetArmed ? "Confirm reset" : "Reset to detected"}
          </span>
          <span className="rail-add-row-cost">
            {resetCount > 0
              ? `Discards ${resetCount} group${resetCount === 1 ? "" : "s"}`
              : "Restores the launch-edge grouping"}
          </span>
        </button>
      )}
    </>
  );
}
