import type { HarnessSession, WorkflowInfo } from "@shared/types";

export interface WorkspaceGroup {
  cwd: string;
  label: string;
  isActive: boolean;
  workflows: WorkflowInfo[];
}

export interface WorkspaceTree {
  groups: WorkspaceGroup[];
  /** Workflows that don't live under any known session's directory. */
  ungrouped: WorkflowInfo[];
}

const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;
const isUnder = (workflowPath: string, cwd: string): boolean => workflowPath === cwd || workflowPath.startsWith(`${cwd}/`);

/**
 * Groups workflows by the session directory they live under: the active
 * session's directory always appears first (even with no workflows yet, so
 * there's always a "you are here" root), then other known sessions' directories
 * that actually own a workflow, then anything left over.
 */
export function buildWorkspaceTree(
  workflows: WorkflowInfo[],
  sessions: HarnessSession[],
  activeSessionId: string | null,
): WorkspaceTree {
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const remaining = new Set(workflows);
  const groups: WorkspaceGroup[] = [];

  const seenCwds = new Set<string>();
  const orderedCwds = [
    ...(activeSession ? [activeSession.cwd] : []),
    ...sessions.map((session) => session.cwd).filter((cwd) => cwd !== activeSession?.cwd),
  ].filter((cwd) => (seenCwds.has(cwd) ? false : (seenCwds.add(cwd), true)));

  for (const cwd of orderedCwds) {
    const owned = workflows.filter((workflow) => remaining.has(workflow) && isUnder(workflow.path, cwd));
    const isActive = cwd === activeSession?.cwd;
    if (owned.length === 0 && !isActive) continue; // don't clutter the rail with empty inactive groups
    owned.forEach((workflow) => remaining.delete(workflow));
    groups.push({ cwd, label: basename(cwd), isActive, workflows: owned });
  }

  return { groups, ungrouped: Array.from(remaining) };
}
