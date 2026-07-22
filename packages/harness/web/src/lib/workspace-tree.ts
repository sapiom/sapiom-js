import type { HarnessSession, WorkflowInfo } from "@shared/types";

/**
 * One agent (workflow) node in the rail. The rail is an EXPLORER of what
 * exists on disk: workspace folders and the agents (sapiom.json) inside them.
 * Sessions are NOT a rail concern anymore — they live in the main panel's tab
 * strip, resolved to the focused agent there. So an agent node
 * carries only its workflow; no session attribute rides here.
 */
export interface AgentNode {
  workflow: WorkflowInfo;
}

/**
 * A workspace folder: LEVEL 1 in the tree. A collapsible header that labels
 * the agents beneath it. It never opens anything, EXCEPT the bare case (no
 * agents, only live sessions), where the folder row itself is the focus
 * target so its sessions can open as tabs in the main panel.
 */
export interface WorkspaceFolder {
  cwd: string;
  label: string;
  /** Agents owned by this folder, stable order (path). */
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

/**
 * The rail's explorer model: workspace folder (LEVEL 1 header) > agents
 * (LEVEL 2 rows). Folders are the distinct directories any session (live or
 * exited) has run in; each agent is filed under the longest such directory
 * that is a prefix of its path. Ordering is STABLE (newest directory activity
 * on top, path order breaking ties), never reshuffled by which agent is
 * focused — a rail that jumps on every click destroys spatial memory. The
 * single filled selection (the focused agent) is asserted by the renderer,
 * not here.
 *
 * Sessions do not appear as rows; they are surfaced only as the bare-folder
 * case (a folder with live sessions but no agent), which stays a focusable
 * workspace row so its sessions can still be reached.
 */
export function buildWorkspaceTree(
  workflows: WorkflowInfo[],
  sessions: HarnessSession[],
): WorkspaceTree {
  const liveSessions = sessions.filter((session) => session.status !== "exited");
  const remaining = new Set(workflows);

  // Newest activity per directory decides the stack order (latest on top);
  // ties keep a deterministic path order.
  const newestByCwd = new Map<string, string>();
  for (const session of sessions) {
    const prev = newestByCwd.get(session.cwd);
    if (!prev || session.createdAt > prev) newestByCwd.set(session.cwd, session.createdAt);
  }
  const orderedCwds = Array.from(newestByCwd.keys()).sort((a, b) => {
    const byNewest = (newestByCwd.get(b) ?? "").localeCompare(newestByCwd.get(a) ?? "");
    return byNewest !== 0 ? byNewest : a.localeCompare(b);
  });

  // Longest known session directory that owns a path (a workflow or a
  // session cwd), so a nested subject lands in its real folder, not an
  // ancestor that also hosts a deeper one.
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
      .sort((a, b) => a.path.localeCompare(b.path))
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
    workspaces.push({ cwd, label: basename(cwd), agents, bareSessions });
  }

  const orphanAgents: AgentNode[] = Array.from(remaining)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((workflow) => ({ workflow }));

  return { workspaces, orphanAgents };
}
