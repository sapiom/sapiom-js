import type { HarnessSession, WorkflowInfo } from "@shared/types";

/**
 * One agent (workflow) node in the rail. The rail is an EXPLORER of what
 * exists on disk: workspace folders and the agents (sapiom.json) inside them.
 * Sessions are NOT a rail concern — they live in the main panel's tab strip,
 * resolved to the focused agent there. So an agent node carries only its
 * workflow; no session attribute rides here.
 */
export interface AgentNode {
  workflow: WorkflowInfo;
}

/**
 * How the rail files agents into groups.
 *
 * Both axes are fields the harness registry actually sends. `WorkflowInfo` is
 * `{ name, path, definitionId, definitionSlug, source }` and a session adds
 * `cwd` and `createdAt` — so a folder and a deployment state are groupable and
 * a repository is NOT. `sapiom.json` does carry `repoFullName`, but the
 * registry drops it on the way through, so "group by repository" would have to
 * invent data; it is left out until the registry surfaces the field.
 */
export type RailGrouping = "workspace" | "deployment";

/** Group and row order. "recent" is newest activity first; "name" is A–Z. */
export type RailSort = "recent" | "name";

/**
 * A workspace folder: LEVEL 1 in the tree. A collapsible header that labels
 * the agents beneath it. It never opens anything, EXCEPT the bare case (no
 * agents, only live sessions), where the folder row itself is the focus
 * target so its sessions can open as tabs in the main panel.
 */
export interface WorkspaceFolder {
  /** Stable identity for collapse state: a real directory when grouping by
   *  workspace, a synthetic facet key otherwise. */
  cwd: string;
  label: string;
  /** Only a real directory can be copied, opened in an IDE or scaffolded into
   *  — a facet header (a deployment bucket) has no path behind it and carries
   *  no actions and no folder glyph. */
  isDirectory: boolean;
  /** Agents owned by this folder. */
  agents: AgentNode[];
  /** Live, unbound sessions whose owning folder is this cwd. Meaningful only
   *  in the bare case (agents empty): the folder row becomes a focusable
   *  workspace row whose sessions open as tabs. */
  bareSessions: HarnessSession[];
}

export interface WorkspaceTree {
  workspaces: WorkspaceFolder[];
  /** Agents that live outside any known session folder — rendered under a
   *  quiet "No workspace" header, still as agent rows. */
  orphanAgents: AgentNode[];
}

const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;
const isUnder = (childPath: string, cwd: string): boolean =>
  childPath === cwd || childPath.startsWith(`${cwd}/`);

const agentOrder =
  (sort: RailSort) =>
  (a: WorkflowInfo, b: WorkflowInfo): number =>
    sort === "name" ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path);

/**
 * The rail's explorer model: workspace folder (LEVEL 1 header) > agents
 * (LEVEL 2 rows). The ⋯ menu files it on one of two axes — Workspace (a real
 * directory) or Deployment (`definitionId != null`, the only lifecycle state
 * an agent has) — and orders it newest-activity-first or A–Z. The single
 * filled selection (the focused agent) is asserted by the renderer, not here.
 */
export function buildWorkspaceTree(
  workflows: WorkflowInfo[],
  sessions: HarnessSession[],
  grouping: RailGrouping = "workspace",
  sort: RailSort = "recent",
  recentDirs: string[] = [],
): WorkspaceTree {
  if (grouping === "deployment") return byDeployment(workflows, sort);
  return byWorkspace(workflows, sessions, sort, recentDirs);
}

/**
 * Deployment is the only lifecycle state an agent has: `definitionId != null`
 * means it is linked and built on Sapiom, null means it is still local. Two
 * buckets, and an empty one is not shown.
 *
 * Sessions are not on this axis at all. An unbound session has no deployment
 * state, so a bucket for it would be a label that is untrue of its contents;
 * the honest answer is that this view is not where you find it (docs/IA.md).
 */
function byDeployment(workflows: WorkflowInfo[], sort: RailSort): WorkspaceTree {
  const order = agentOrder(sort);
  const bucket = (label: string, key: string, match: (w: WorkflowInfo) => boolean): WorkspaceFolder => ({
    cwd: `deployment:${key}`,
    label,
    isDirectory: false,
    agents: workflows.filter(match).sort(order).map((workflow) => ({ workflow })),
    bareSessions: [],
  });
  const groups = [
    bucket("Deployed", "live", (w) => w.definitionId != null),
    bucket("Draft", "draft", (w) => w.definitionId == null),
  ].filter((group) => group.agents.length > 0);

  return { workspaces: groups, orphanAgents: [] };
}

function byWorkspace(
  workflows: WorkflowInfo[],
  sessions: HarnessSession[],
  sort: RailSort,
  recentDirs: string[],
): WorkspaceTree {
  const liveSessions = sessions.filter((session) => session.status !== "exited");
  const remaining = new Set(workflows);

  // Newest activity per directory, for folders `recentDirs` has not heard of.
  const newestByCwd = new Map<string, string>();
  for (const session of sessions) {
    const prev = newestByCwd.get(session.cwd);
    if (!prev || session.createdAt > prev) newestByCwd.set(session.cwd, session.createdAt);
  }

  // A workspace is a folder you opened, NOT a folder something happened to run
  // in. `HarnessSettings.recentDirs` is upstream's workspace list ("most-recently
  // used project directories, newest first") — already persisted, deduped, and
  // pruned of dead paths at every boot. Session activity only widens the
  // candidate set for folders recentDirs has not yet recorded.
  const candidateCwds = new Set([...newestByCwd.keys(), ...recentDirs]);

  // recentDirs is MRU and survives session pruning, so it is the better recency
  // key; session activity only answers for folders missing from it.
  const byRecency = (a: string, b: string): number => {
    const ia = recentDirs.indexOf(a);
    const ib = recentDirs.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0 || ib >= 0) return ia >= 0 ? -1 : 1;
    return (newestByCwd.get(b) ?? "").localeCompare(newestByCwd.get(a) ?? "");
  };

  const orderedCwds = Array.from(candidateCwds).sort((a, b) => {
    if (sort === "name") return basename(a).localeCompare(basename(b)) || a.localeCompare(b);
    return byRecency(a, b) || a.localeCompare(b);
  });

  // Longest known workspace directory that owns a path (a workflow or a session
  // cwd), so a nested subject lands in its real folder, not an ancestor that
  // also hosts a deeper one.
  const ownerCwdOf = (path: string): string | null => {
    let best: string | null = null;
    for (const cwd of orderedCwds) {
      if (isUnder(path, cwd) && (best === null || cwd.length > best.length)) best = cwd;
    }
    return best;
  };

  const workspaces: WorkspaceFolder[] = [];
  for (const cwd of orderedCwds) {
    const agents: AgentNode[] = workflows
      .filter((workflow) => remaining.has(workflow) && ownerCwdOf(workflow.path) === cwd)
      .sort(agentOrder(sort))
      .map((workflow) => {
        remaining.delete(workflow);
        return { workflow };
      });
    // Live, unbound sessions filed under this folder — the bare-scaffold case
    // when the folder has no agents (the folder row becomes the focus target).
    const bareSessions = liveSessions
      .filter((session) => session.boundWorkflowPath == null && ownerCwdOf(session.cwd) === cwd)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    // Nothing to show: no agents and no live session to keep the folder alive.
    if (agents.length === 0 && bareSessions.length === 0) continue;
    workspaces.push({ cwd, label: basename(cwd), isDirectory: true, agents, bareSessions });
  }

  const orphanAgents: AgentNode[] = Array.from(remaining)
    .sort(agentOrder(sort))
    .map((workflow) => ({ workflow }));

  return { workspaces, orphanAgents };
}
