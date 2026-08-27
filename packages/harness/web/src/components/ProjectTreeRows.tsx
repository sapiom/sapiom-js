import type { CSSProperties, JSX, ReactNode } from "react";

import { Icon } from "./Icon";
import { WorkflowRow } from "./WorkflowRow";
import { projectInitial } from "../lib/project-tree";
import type { AgentNode, DirNode } from "../lib/project-tree";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

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
}: {
  dirs: DirNode[];
  agents: AgentNode[];
  /** 0 for rows directly under the project row. */
  depth: number;
  focusedAgentPath: string | null;
  onFocusAgent: (path: string) => void;
  collapsedKeys: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
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
        />
      ))}
      {dirs.map((dir) => {
        const collapsed = collapsedKeys.has(dirKey(dir.path));
        return (
          <div key={dir.path} className="workspace-group workspace-subgroup">
            <div
              className={"workspace-row is-nested" + (collapsed ? " is-collapsed" : "")}
              data-testid={`dir-row-${dir.labelFull}`}
              style={{ "--tree-depth": depth } as CSSProperties}
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
 * The disclosure owns collapse; the rest of the row focuses the agent and
 * carries the agent's selection, which is why the row also wears
 * `.workflow-item` and the agent's testid: it IS that agent's row.
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
  focusedAgentPath,
  onFocusAgent,
  trailing,
  focusable = false,
  disclosable = true,
  mainTestid,
  tooltip,
  busy = false,
}: {
  label: string;
  root: string;
  rootAgent: AgentNode | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
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
}): JSX.Element {
  const agentPath = rootAgent?.workflow.path ?? null;
  // A merged root-agent row IS that agent's row, so it takes the agent's
  // selection styling; a plain project row takes the container's.
  const isFocused =
    (agentPath != null && agentPath === focusedAgentPath) ||
    (focusable && root === focusedAgentPath);
  const focusTarget = agentPath ?? (focusable ? root : null);
  return (
    <div
      className={
        "workspace-row" +
        (rootAgent ? " workflow-item" : "") +
        (isFocused ? (rootAgent ? " is-focused" : " is-selected") : "") +
        (disclosable && collapsed ? " is-collapsed" : "")
      }
      data-testid={rootAgent ? `workflow-${rootAgent.workflow.name}` : `project-row-${label}`}
      {...trackingAttrs({ object: rootAgent ? "agent" : "workspace" })}
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
        <span className="row-disclosure row-disclosure-static" aria-hidden="true">
          <span className="row-disclosure-mark">
            <ProjectMark root={root} />
          </span>
        </span>
      )}
      <button
        type="button"
        className={"workspace-row-main" + (rootAgent ? " workflow-item-trigger" : "")}
        data-testid={mainTestid}
        onClick={
          focusTarget ? () => onFocusAgent(focusTarget) : disclosable ? onToggleCollapsed : undefined
        }
        /* The ABSOLUTE path, matching every other row. The row shows what it
           is; the title answers where it lives. */
        title={root}
        aria-expanded={focusTarget || !disclosable ? undefined : !collapsed}
        aria-pressed={focusTarget && !busy ? isFocused : undefined}
        aria-busy={busy ? true : undefined}
        aria-label={focusTarget ? `Focus ${label}` : undefined}
        data-tooltip={tooltip ?? (focusTarget ? "Focus this agent" : undefined)}
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
      {/* No per-project `+`. It was hover-only, so the one action a project row
          offered was invisible at rest — and once sessions are project-scoped,
          opening a project IS the request. Starting another session is the tab
          strip's trailing `+`; adding a project is the header's. */}
    </div>
  );
}
