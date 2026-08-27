import type {
  AgentKey,
  SystemGraphNode,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "@shared/system-graph";
import type { WorkflowInfo } from "@shared/types";

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function canonicalSegments(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean);
}

function sameSegment(left: string, right: string, windows: boolean): boolean {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function relativeWithin(root: string, candidate: string): string[] | null {
  const windows = isWindowsPath(root);
  if (windows !== isWindowsPath(candidate)) return null;
  const rootSegments = canonicalSegments(root);
  const candidateSegments = canonicalSegments(candidate);
  if (
    rootSegments.length > candidateSegments.length ||
    rootSegments.some(
      (segment, index) =>
        !sameSegment(segment, candidateSegments[index]!, windows),
    )
  ) {
    return null;
  }
  return candidateSegments.slice(rootSegments.length);
}

function localAgentKey(root: string, workflowPath: string): AgentKey | null {
  const relative = relativeWithin(root, workflowPath);
  if (relative === null) return null;
  const local =
    relative.length > 0
      ? relative.join("/")
      : canonicalSegments(workflowPath).at(-1);
  return local ? `local:${local}` : null;
}

/**
 * Navigation is deliberately narrower than graph projection. The public graph
 * omits source paths, so Studio may open a card only when its public AgentKey
 * matches registry evidence already in memory. Display labels never resolve.
 */
export function mapSystemGraphNavigation(
  nodes: readonly SystemGraphNode[],
  workspaceKey: WorkspaceKey,
  workflows: readonly WorkflowInfo[],
  scopes: readonly WorkspaceScopeSummary[],
): ReadonlyMap<AgentKey, WorkflowInfo> {
  const selected = scopes.find((scope) => scope.workspaceKey === workspaceKey);
  if (!selected) return new Map();
  const graphKeys = new Set(nodes.map((node) => node.agentKey));
  const candidates = new Map<AgentKey, Set<WorkflowInfo>>();
  const register = (key: AgentKey | null, workflow: WorkflowInfo): void => {
    if (!key || !graphKeys.has(key)) return;
    const matches = candidates.get(key) ?? new Set<WorkflowInfo>();
    matches.add(workflow);
    candidates.set(key, matches);
  };
  for (const workflow of workflows) {
    // Match the same selected-root containment used by the Project rail and
    // backend inventory. A nested agent is navigable from both its own project
    // graph and any containing parent project graph.
    if (relativeWithin(selected.cwd, workflow.path) === null) continue;
    register(workflow.definitionSlug?.trim() || null, workflow);
    register(localAgentKey(selected.cwd, workflow.path), workflow);
  }
  return new Map(
    [...candidates.entries()]
      .filter(([, matches]) => matches.size === 1)
      .map(([key, matches]) => [key, [...matches][0]!] as const),
  );
}
