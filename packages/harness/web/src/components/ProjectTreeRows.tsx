import type {
  CSSProperties,
  DOMAttributes,
  DragEvent as ReactDragEvent,
  JSX,
  ReactNode,
} from "react";
import type { WorkspaceKey } from "@shared/system-graph";

import { Icon } from "./Icon";
import { WorkflowRow } from "./WorkflowRow";
import { projectInitial } from "../lib/project-tree";
import type { AgentNode, DirNode } from "../lib/project-tree";
import { DRAG_MOVE_TYPE } from "../lib/agent-move";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * Everything a row needs to take part in a MOVE, threaded down the recursion the
 * same way collapse state already is (SAP-2930).
 *
 * Absent = this axis does not offer a move, and no row grows a drag handle or a
 * drop target. Only the Project axis passes it: that axis is derived from real
 * paths, so a drag there has to change the filesystem or refuse. The Group axis
 * rearranges meaning, not files, and has its own drag in `GroupRow.tsx`.
 *
 * `dropDir` is the directory currently under the pointer, held by the RAIL
 * rather than by each row, because only one row may be the target at a time and
 * rows that own their own hover state disagree mid-drag.
 */
export interface RailDrag {
  dropDir: string | null;
  setDropDir: (dir: string | null) => void;
  /** What a drop MEANS lives with the rail, which owns the plan and the toast. */
  onDropInto: (agentPath: string, targetDir: string) => void;
}

/**
 * A drop target only lights up for OUR payload, and only for the payload that
 * offers a move: without the type check any dragged file — or a Group-axis drag,
 * which carries different types — would highlight the tree and imply a move the
 * row must not perform.
 *
 * `types` is readable during `dragover` (the spec's protected mode) and `getData`
 * is not, so the highlight keys on "an agent is being dragged for a move" and
 * only the drop reads which one.
 */
function dropHandlersFor(
  targetDir: string,
  drag: RailDrag | undefined,
): DOMAttributes<HTMLDivElement> {
  if (!drag) return {};
  return {
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(DRAG_MOVE_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (drag.dropDir !== targetDir) drag.setDropDir(targetDir);
    },
    onDragLeave: (event) => {
      // A directory's own children fire dragleave too; only a pointer that has
      // actually left the row clears the highlight.
      if (event.currentTarget.contains(event.relatedTarget as Node | null))
        return;
      if (drag.dropDir === targetDir) drag.setDropDir(null);
    },
    onDrop: (event) => {
      if (!event.dataTransfer.types.includes(DRAG_MOVE_TYPE)) return;
      event.preventDefault();
      drag.setDropDir(null);
      const agentPath = event.dataTransfer.getData(DRAG_MOVE_TYPE);
      if (agentPath) drag.onDropInto(agentPath, targetDir);
    },
  };
}

/**
 * What makes an agent row a DRAG SOURCE, or nothing when this axis offers no
 * move.
 *
 * The handlers go on the row itself rather than on a wrapper host: this row's
 * ORDER among its siblings is asserted structurally (`e2e/project-axis.spec.ts`
 * walks `element.children` to prove agents render before directories at every
 * level), and an extra element changed that walk — a rendered rule the rail was
 * corrected to obey, broken by a node that exists only to hold two attributes.
 *
 * `effectAllowed` is "move", not the Group axis's "copyMove": there is no such
 * thing as copying a directory on the Project axis. The axis shows where files
 * ARE, and a source offering a copy cursor would promise a duplicate it cannot
 * make.
 */
function dragSourceProps(
  agent: AgentNode,
  drag: RailDrag | undefined,
): {
  draggable?: boolean;
  onDragStart?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
} {
  if (!drag) return {};
  return {
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.effectAllowed = "move";
      // THE PAYLOAD RIDES HERE, not in component state: `dragstart` and `drop`
      // can land in the same tick, and a state setter has not re-rendered by
      // then, so a state-held path reads as null exactly when the drop needs it.
      event.dataTransfer.setData(DRAG_MOVE_TYPE, agent.workflow.path);
    },
    onDragEnd: () => drag.setDropDir(null),
  };
}

/**
 * Collapse keys are NAMESPACED because a path is not unique across row kinds.
 * `~/trend-loop/agents` opened as its own project is the exact string the
 * `agents` subdirectory inside `~/trend-loop` already uses, so one shared Set
 * collapsed both rows at once — same path, two different things on screen.
 */
export const projectKey = (root: string): string => `project:${root}`;
export const dirKey = (path: string): string => `dir:${path}`;

/**
 * The row's left slot: identity at rest, disclosure on hover.
 *
 * The chevron used to sit in its own trailing column, permanently reserving
 * width on every row to say something the row only needs to say when you are
 * about to act on it. Here the icon you already look at IS the control — hover
 * the row and the mark or folder glyph becomes a chevron in place. Zero extra
 * width, and the affordance appears exactly where the pointer already is.
 *
 * Both children stay mounted and swap by CSS, so the slot never changes size
 * and the row cannot reflow under the cursor. A COLLAPSED row shows its
 * chevron unhovered: "there is more here" must never be invisible.
 */
export function RowDisclosure({
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
 * The project's mark.
 *
 * A project takes a mark, not a folder glyph: it is what the tree is ABOUT,
 * not a folder in it. The letter is DERIVED from the folder name, never
 * fetched — GitHub serves an auto-generated identicon for an org with no
 * avatar set, which renders as though it were a logo, while the same repo
 * often carries its actual mark at `frontend/public/favicon.ico`. Until a
 * route serves a file out of a project (a bounded local scan, deliberately not
 * in this slice), every row shows its initial, which is honest.
 */
function ProjectMark({ root }: { root: string }): JSX.Element {
  return (
    <span className="project-mark" aria-hidden="true">
      {projectInitial(root)}
    </span>
  );
}

/**
 * The nested rows inside a project: directories that actually branch, and the
 * agents under them.
 *
 * A directory only earns a row where the tree BRANCHES. An unbranched run is
 * compacted — either into one directory label (`backend/src/agents`) or, when
 * it leads to a single agent, onto that agent's own row as a dimmed prefix.
 * Spending three rows to walk down to one agent is how a rail full of monorepo
 * paths stops being scannable, which is the thing the explorer is for.
 *
 * AGENTS COME BEFORE DIRECTORIES at every level, which is the opposite of a
 * file explorer and deliberate: this is an explorer of AGENTS, and a directory
 * is scaffolding around them. Dirs-first buried the agent a project is named
 * for underneath the folder holding the six agents it launches. Compaction
 * already makes directory rows rare (they survive only at real branch points),
 * so putting the clickable things first costs almost nothing.
 *
 * Depth rides as a CSS custom property so the indent step stays a token rather
 * than arithmetic scattered through the markup.
 */
export function ProjectTreeRows({
  dirs,
  agents,
  depth,
  focusedAgentPath,
  onFocusAgent,
  collapsedKeys,
  onToggleCollapsed,
  drag,
}: {
  dirs: DirNode[];
  agents: AgentNode[];
  /** 0 for rows directly under the project row. */
  depth: number;
  focusedAgentPath: string | null;
  onFocusAgent: (path: string) => void;
  collapsedKeys: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  /** Absent = no move is offered here. See `RailDrag`. */
  drag?: RailDrag;
}): JSX.Element {
  return (
    <>
      {agents.map((agent) => (
        <WorkflowRow
          key={agent.workflow.path}
          workflow={agent.workflow}
          isFocused={agent.workflow.path === focusedAgentPath}
          onFocus={onFocusAgent}
          prefix={agent.prefix}
          prefixFull={agent.prefixFull}
          depth={depth}
          {...dragSourceProps(agent, drag)}
        />
      ))}
      {dirs.map((dir) => {
        const collapsed = collapsedKeys.has(dirKey(dir.path));
        return (
          <div key={dir.path} className="workspace-group workspace-subgroup">
            <div
              className={
                "workspace-row is-nested" +
                (collapsed ? " is-collapsed" : "") +
                (drag?.dropDir === dir.path ? " is-drop-target" : "")
              }
              data-testid={`dir-row-${dir.labelFull}`}
              style={{ "--tree-depth": depth } as CSSProperties}
              {...dropHandlersFor(dir.path, drag)}
              {...trackingAttrs({ object: "workspace" })}
            >
              <RowDisclosure
                collapsed={collapsed}
                onToggle={() => onToggleCollapsed(dirKey(dir.path))}
                label={dir.label}
                testid={`dir-disclosure-${dir.labelFull}`}
              >
                <Icon name={collapsed ? "Folder" : "FolderOpen"} size={13} />
              </RowDisclosure>
              <button
                type="button"
                className="workspace-row-main"
                onClick={() => onToggleCollapsed(dirKey(dir.path))}
                /* The ABSOLUTE path. The row shows what it is — a compacted,
                   maybe elided chain; the title answers where it lives, and
                   only the absolute path answers that. */
                title={dir.path}
                aria-expanded={!collapsed}
              >
                <span className="tree-row-label">{dir.label}</span>
              </button>
            </div>
            {!collapsed && (
              <ProjectTreeRows
                dirs={dir.dirs}
                agents={dir.agents}
                depth={depth + 1}
                focusedAgentPath={focusedAgentPath}
                onFocusAgent={onFocusAgent}
                collapsedKeys={collapsedKeys}
                onToggleCollapsed={onToggleCollapsed}
                drag={drag}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * The project's own row.
 *
 * When the project root is ALSO an agent project (a `sapiom.json` sitting at
 * the folder you opened), the row and that agent are the same directory — so
 * this is ONE row, not a folder row with an identically-named child under it.
 * The disclosure owns collapse; the label opens the project graph once the
 * server has issued its workspace key. Until then a pending root-agent row may
 * still focus that agent. The row wears `.workflow-item` because it represents
 * both the project root and that root agent without printing either twice.
 *
 * Printing both was the defining texture of a real install's rail — the folder
 * said `dashboard-keeper`, and the only thing inside it said `dashboard-keeper`
 * again. Two rows, one fact, fifteen times over.
 */
export function ProjectRow({
  label,
  root,
  rootAgent,
  collapsed,
  onToggleCollapsed,
  workspaceKey,
  selected,
  onSelectProject,
  focusedAgentPath,
  onFocusAgent,
  trailing,
  focusable = false,
  disclosable = true,
  mainTestid,
  tooltip,
  busy = false,
  drag,
}: {
  label: string;
  root: string;
  rootAgent: AgentNode | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Opaque server identity for this exact project root. Null only while a
   * newly-opened root has not reached the scope catalog yet. */
  workspaceKey: WorkspaceKey | null;
  /** Whether this project's full-main dependency graph is selected. */
  selected: boolean;
  onSelectProject: (
    workspaceKey: WorkspaceKey,
    root: string,
    label: string,
  ) => void;
  focusedAgentPath: string | null;
  onFocusAgent: (path: string) => void;
  /** Row-end slot for state that belongs to the project itself (the
   *  mid-creation spinner). Never a deploy glyph — see below. */
  trailing?: ReactNode;
  /** A project with no agents of its own but a live session in it, or one
   *  mid-creation: the row itself is the focus target so those sessions can
   *  open as tabs and an in-progress agent stays findable. */
  focusable?: boolean;
  /** False when the project has no rows under it. A row with nothing to
   *  disclose must not grow a chevron on hover: the control would toggle a
   *  fold that changes nothing, which is a small lie the rail can avoid by
   *  simply not offering it. */
  disclosable?: boolean;
  mainTestid?: string;
  tooltip?: string;
  busy?: boolean;
  /** The project row is a DROP TARGET (the root is a directory like any other),
   *  never a drag source: moving the folder the project IS would move the
   *  project, which is what removing and adding one is for. */
  drag?: RailDrag;
}): JSX.Element {
  const agentPath = rootAgent?.workflow.path ?? null;
  // Project selection takes precedence over the merged root-agent identity:
  // the row names the project boundary, and its label opens that boundary's
  // graph. The graph card remains the door into the root agent itself.
  const isFocused =
    (agentPath != null && agentPath === focusedAgentPath) ||
    (focusable && root === focusedAgentPath);
  const focusTarget = agentPath ?? (focusable ? root : null);
  return (
    <div
      className={
        "workspace-row" +
        (rootAgent ? " workflow-item" : "") +
        (selected ? " is-selected" : "") +
        (!selected && isFocused
          ? rootAgent
            ? " is-focused"
            : " is-selected"
          : "") +
        (disclosable && collapsed ? " is-collapsed" : "") +
        (drag?.dropDir === root ? " is-drop-target" : "")
      }
      data-testid={
        rootAgent
          ? `workflow-${rootAgent.workflow.name}`
          : `project-row-${label}`
      }
      {...dropHandlersFor(root, drag)}
      {...trackingAttrs({ object: "workspace" })}
    >
      {disclosable ? (
        <RowDisclosure
          collapsed={collapsed}
          onToggle={onToggleCollapsed}
          label={label}
          testid={`project-disclosure-${label}`}
        >
          <ProjectMark root={root} />
        </RowDisclosure>
      ) : (
        <span
          className="row-disclosure row-disclosure-static"
          aria-hidden="true"
        >
          <span className="row-disclosure-mark">
            <ProjectMark root={root} />
          </span>
        </span>
      )}
      <button
        type="button"
        className={
          "workspace-row-main" + (rootAgent ? " workflow-item-trigger" : "")
        }
        data-testid={mainTestid ?? `project-select-${label}`}
        /* THE MORE SPECIFIC IDENTITY WINS. `workspaceKey` used to be tested
           first, so a row whose root IS an agent ALWAYS opened the project
           graph and never the agent, and that graph had exactly one node
           because nothing else lives in that folder. "I have to click that in
           order to see my agent" was this expression, and one operator ordering
           is the whole of it: the two behaviours were both already built and
           only one was reachable.
           A row that names an agent opens that agent. A row that names only a
           project opens the project's graph, which is the one case where the
           graph is the more specific answer. The map stays reachable on a
           merged row through the trailing control the rail passes, so nothing
           is lost, and the two subjects stop competing for one click. */
        onClick={
          focusTarget
            ? () => onFocusAgent(focusTarget)
            : workspaceKey
              ? () => onSelectProject(workspaceKey, root, label)
              : undefined
        }
        /* The ABSOLUTE path, matching every other row. The row shows what it
           is; the title answers where it lives. */
        title={root}
        aria-pressed={
          focusTarget ? (busy ? undefined : isFocused) : workspaceKey ? selected : undefined
        }
        aria-busy={busy ? true : undefined}
        aria-label={
          focusTarget
            ? `Focus ${label}`
            : workspaceKey
              ? `Open dependency graph for ${label}`
              : undefined
        }
        data-tooltip={
          tooltip ??
          (focusTarget
            ? "Focus this agent"
            : workspaceKey
              ? "Open dependency graph"
              : undefined)
        }
      >
        <span className="tree-row-label">{label}</span>
        {/* NO deploy glyph here, even when this project's root IS an agent.
            Deployment is a per-AGENT fact, and putting it on a project row
            made it look like a property of the PROJECT — which then appeared
            on one project and not its neighbour for reasons nothing on screen
            explained. The root agent's cloud state is shown where the rest of
            its lifecycle is: the right pane's Draft/Deployed pill. */}
      </button>
      {trailing}
    </div>
  );
}
