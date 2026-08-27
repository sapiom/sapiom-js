import { useRef, useState } from "react";
import type { JSX } from "react";

import { Icon } from "./Icon";
import { AnchoredPopover } from "./AnchoredPopover";
import { RowDisclosure } from "./ProjectTreeRows";
import type { AgentNode } from "../lib/project-tree";
import { prefixIsPathTail } from "../lib/project-tree";
import { basenameOf, parentOf } from "../lib/paths";
import { rootContains } from "../lib/session-scope";
import { displayAgentName } from "../lib/agent-name";
import { workflowDeploymentState } from "../lib/workflow-deployment";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * "Outside your projects" — agents no open project contains.
 *
 * Round 1 rendered these with the ordinary `WorkflowRow`, which was correct
 * about everything except the one thing that only shows up on a real install:
 * this section is not a footnote. On the user's machine it held ~78 of 88
 * agents, six of them named `ari-grade-repo` and six named `brain-agent`,
 * across git worktrees. That produced a section of identical rows sharing one
 * testid, with a hover that said "Focus this agent" and nothing about which
 * agent, sitting below everything else in an unbounded list.
 *
 * So it gets its own row anatomy, and each departure from `WorkflowRow` is one
 * of those failures:
 *
 *  1. **The tooltip is the absolute path.** The design says every row's title
 *     is its absolute path, and `WorkflowRow` does set `title`. But the app's
 *     tooltip layer reads `data-tooltip` FIRST and only falls back to the
 *     stashed native title (`TooltipLayer.show`), so a row carrying both shows
 *     the `data-tooltip` and the path is never reachable by hover at all.
 *     Elsewhere that trade is right — "Focus this agent" is the useful thing
 *     to say. Here the path IS the useful thing to say, because it is the only
 *     thing that distinguishes the row.
 *  2. **The row is disambiguated on screen**, by the grow-leftward prefix
 *     `unrootedAgents` computes. [SEEN] rule 1 (immediate parent only) is the
 *     default and still holds for every row that doesn't collide; a row whose
 *     name AND parent are shared with five others has no one-segment label
 *     that means anything, and the rule the design already states for that is
 *     "grow leftward until they differ".
 *  3. **The testid is the PATH**, not the name. Six rows sharing
 *     `workflow-ari-grade-repo` are six rows a test cannot address, and the
 *     e2e suite was addressing the first one and calling it the agent.
 *  4. **The section collapses, and names its count.** It is the least
 *     important thing on screen and, on a real install, the largest; left open
 *     it pushes every project — and on the Group axis every group — out of the
 *     viewport, which is how "switching the Group axis doesn't do anything"
 *     gets reported about an axis that works.
 *  5. **Every row offers "Open as project"**, which is the missing half of
 *     Remove project. Without it the section is a place agents fall into and
 *     never leave.
 */

/**
 * The unrooted section's disclosure key.
 *
 * A NEW namespace (`unrooted:`), not a reused path key — the section is not a
 * path, and `collapsedKeys` is namespaced precisely because one bare string
 * meant two different rows.
 *
 * Its sense is INVERTED against every other key in that set: present means
 * EXPANDED. This is the one section whose default is closed, and the stored
 * set only records departures from a default, so the departure here is the
 * user having opened it. The name says so rather than relying on this comment.
 */
export const UNROOTED_KEY = "unrooted:expanded";

/** How far above an agent "Open as project" will offer to reach. Five is
 *  already past `worktrees/design-agent-port-pin/ari/orchestration`, and a
 *  list long enough to scroll would be a worse answer than a short one. */
const MAX_ANCESTORS = 5;
/** Path segments below the filesystem root, separator-insensitive. */
const depthOf = (p: string): number =>
  p
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && !/^[A-Za-z]:$/.test(segment)).length;

/**
 * The folders "Open as project" offers, deepest first.
 *
 * The agent's OWN directory leads, because that is the honest default and the
 * one `projectRootForAgent` already falls back to — it is guaranteed to
 * contain the agent and to contain nothing the user did not ask about. But it
 * is very often not what the user means: `design-eng/ari/orchestration` is one
 * agent of a repo, and opening `orchestration` leaves its five siblings in
 * this same section, so a one-click default would have to be re-clicked once
 * per agent to clear a flood of 78.
 *
 * Rather than guess, the row asks — and makes the choice decidable by printing
 * the fact that decides it: how many registered agents each folder would take
 * with it. That number is the whole question ("will this clear the flood?"),
 * and it is a fact about the registry, not a preference.
 *
 * Stops below the filesystem root: `/` is never a project.
 */
export function openAsProjectCandidates(
  agentPath: string,
  agentPaths: readonly string[],
): { root: string; label: string; agentCount: number }[] {
  const describe = (root: string): { root: string; label: string; agentCount: number } => ({
    root,
    label: basenameOf(root),
    agentCount: agentPaths.filter((path) => rootContains(root, path)).length,
  });
  const out: { root: string; label: string; agentCount: number }[] = [];
  let cursor: string | null = agentPath;
  // Two segments is the floor: `/` and `/Users` are not projects, and offering
  // them would offer to file every agent on the machine under one row.
  while (cursor != null && out.length < MAX_ANCESTORS && depthOf(cursor) >= 2) {
    out.push(describe(cursor));
    cursor = parentOf(cursor);
  }
  // A shallow agent path (`/srv/thing`) has no ancestor worth offering; its own
  // folder is then the only honest answer, and it is still a real one.
  return out.length > 0 ? out : [describe(agentPath)];
}


/** `3 agents`, `1 agent` — the fact that decides which folder to open. */
const describeCount = (n: number): string => `${n} agent${n === 1 ? "" : "s"}`;

function OpenAsProject({
  agent,
  agentPaths,
  onOpenAsProject,
}: {
  agent: AgentNode;
  agentPaths: readonly string[];
  onOpenAsProject: (root: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const candidates = openAsProjectCandidates(agent.workflow.path, agentPaths);
  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="workspace-row-action"
        data-testid={`unrooted-open-${agent.workflow.path}`}
        aria-label={`Open a project for ${agent.workflow.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip="Open as project"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="FolderPlus" size={13} />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={() => setOpen(false)}
        placement="down-end"
        className="menu-flyer"
        testid={`unrooted-open-menu-${agent.workflow.path}`}
      >
        <div className="connect-card">
          <div className="connect-card-header">
            <span>Open which folder?</span>
          </div>
          <div className="connect-card-body" role="menu">
            {/* The COUNT is why this is a list and not a button. The folders
                differ only in how much they bring with them, and that is the
                thing the user is actually choosing between. */}
            {candidates.map((candidate) => (
              <button
                key={candidate.root}
                type="button"
                role="menuitem"
                className="rail-add-row unrooted-open-choice"
                data-testid={`unrooted-open-choice-${candidate.root}`}
                title={candidate.root}
                onClick={() => {
                  setOpen(false);
                  onOpenAsProject(candidate.root);
                }}
              >
                <Icon name="Folder" size={13} />
                <span className="unrooted-open-choice-label">{candidate.label}</span>
                <span className="rail-add-row-cost">{describeCount(candidate.agentCount)}</span>
              </button>
            ))}
          </div>
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * One unrooted agent row. Same anatomy as `WorkflowRow` — prefix and name are
 * ONE flex child with the `/` outside the truncating span ([SEEN] rule 2) —
 * with the row's identity moved onto the path.
 */
function UnrootedRow({
  agent,
  isFocused,
  onFocus,
  agentPaths,
  onOpenAsProject,
}: {
  agent: AgentNode;
  isFocused: boolean;
  onFocus: (path: string) => void;
  agentPaths: readonly string[];
  onOpenAsProject: (root: string) => void;
}): JSX.Element {
  const { workflow, prefix } = agent;
  const name = displayAgentName(workflow.name);
  /* Slash only where the join is really a path — see
     `project-tree.prefixIsPathTail`. `ari-grade-repo` in `ari/orchestration`
     must not render as `ari/ari-grade-repo`, which names nothing on disk. */
  const pathTail = prefixIsPathTail(workflow, name);
  const deploymentState = workflowDeploymentState(workflow);
  const deployed = deploymentState === "ready";
  return (
    <div
      className={"workflow-item unrooted-item" + (isFocused ? " is-focused" : "")}
      /* THE PATH, not the name. `workflow-<name>` was six rows deep on a real
         install and neither a test nor a user could say which one they had. */
      data-testid={`unrooted-agent-${workflow.path}`}
      data-agent-name={workflow.name}
      {...trackingAttrs({ object: "agent" })}
    >
      <button
        className="tree-row workflow-item-trigger"
        onClick={() => onFocus(workflow.path)}
        aria-pressed={isFocused}
        /* Both, and both the same string: `title` is the design's stated
           contract for every row, and `data-tooltip` is what the app's tooltip
           layer actually renders. A row whose only distinguishing fact is its
           path cannot afford to say "Focus this agent" instead. */
        title={workflow.path}
        data-tooltip={workflow.path}
      >
        <span className="tree-row-name">
          {prefix && (
            <>
              <span className="tree-row-prefix" data-testid={`unrooted-prefix-${workflow.path}`}>
                {prefix}
              </span>
              <span
                className={"tree-row-sep" + (pathTail ? "" : " tree-row-sep-loose")}
                aria-hidden="true"
              >
                {pathTail ? "/" : "·"}
              </span>
            </>
          )}
          <span className="tree-row-label" data-testid={`unrooted-name-${workflow.path}`}>
            {name}
          </span>
        </span>
        {/* The same deployment glyph every other agent row carries. An agent
            being outside a project says nothing about whether it is deployed,
            and dropping the glyph here would make these rows differ from the
            rest of the rail for a reason nothing on screen explains. */}
        <span
          className="workflow-status"
          data-deployed={deployed}
          data-deployment-state={deploymentState}
          data-testid={`unrooted-status-${workflow.path}`}
        >
          <Icon name={deployed ? "Cloud" : "CloudOff"} size={13} />
        </span>
      </button>
      <OpenAsProject agent={agent} agentPaths={agentPaths} onOpenAsProject={onOpenAsProject} />
    </div>
  );
}

/**
 * The whole section: a collapsible header that names its count, then the rows.
 *
 * Rendered LAST in the rail list, always — a project the user chose outranks a
 * folder they never opened, and on the Group axis the groups have to be the
 * thing that moves when the axis changes.
 */
export function UnrootedAgents({
  agents,
  collapsed,
  onToggleCollapsed,
  focusedAgentPath,
  onFocusAgent,
  agentPaths,
  onOpenAsProject,
}: {
  agents: AgentNode[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  focusedAgentPath: string | null;
  onFocusAgent: (path: string) => void;
  /** Every registered agent path, for the "N agents" count on each candidate
   *  folder. The registry, not the visible rows: the point of the number is
   *  what the folder would bring in. */
  agentPaths: readonly string[];
  onOpenAsProject: (root: string) => void;
}): JSX.Element {
  return (
    <div className="workspace-group" data-testid="unrooted-section">
      <div className={"workspace-row" + (collapsed ? " is-collapsed" : "")}>
        <RowDisclosure
          collapsed={collapsed}
          onToggle={onToggleCollapsed}
          label="agents outside your projects"
          testid="unrooted-disclosure"
        >
          <span className="project-mark project-mark-none" aria-hidden="true">
            <Icon name="Folder" size={13} />
          </span>
        </RowDisclosure>
        <button
          type="button"
          className="workspace-row-main"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          data-testid="unrooted-header"
          data-tooltip="Agents that live outside every project you have open. Open the folder above one as a project to file it."
        >
          <span className="tree-row-label">Outside your projects</span>
          {/* The COUNT is on the row because the section is closed by default:
              a closed row that does not say how much it is hiding is a row the
              user has no reason to open. */}
          <span className="unrooted-count" data-testid="unrooted-count">
            {agents.length}
          </span>
        </button>
      </div>
      {!collapsed &&
        agents.map((agent) => (
          <UnrootedRow
            key={agent.workflow.path}
            agent={agent}
            isFocused={agent.workflow.path === focusedAgentPath}
            onFocus={onFocusAgent}
            agentPaths={agentPaths}
            onOpenAsProject={onOpenAsProject}
          />
        ))}
    </div>
  );
}
