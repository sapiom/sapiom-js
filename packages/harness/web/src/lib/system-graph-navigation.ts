import {
  workspaceRelativeLocalKey,
  type AgentKey,
  type SystemGraphNode,
  type WorkspaceKey,
  type WorkspaceScopeSummary,
} from "@shared/system-graph";
import type { WorkflowInfo } from "@shared/types";

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
    const localKey = workspaceRelativeLocalKey(selected.cwd, workflow.path);
    if (localKey === null) continue;
    register(workflow.definitionSlug?.trim() || null, workflow);
    register(localKey, workflow);
  }
  return new Map(
    [...candidates.entries()]
      .filter(([, matches]) => matches.size === 1)
      .map(([key, matches]) => [key, [...matches][0]!] as const),
  );
}
