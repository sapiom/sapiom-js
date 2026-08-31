import type { AgentKey, SystemGraphNode } from "@shared/system-graph";

import { UNGROUPED_ID, type GroupNode } from "./agent-groups";
import {
  SYSTEM_GRAPH_UNGROUPED_LABEL,
  type SystemGraphNodeGroup,
} from "./system-graph-layout";

/**
 * The join between the rail's GROUP axis and the project map.
 *
 * The map used to draw every agent a project contains as one flat set, ignoring
 * the sub-structure the rail was showing six inches to its left: one root
 * holding several systems and a few dozen agents came out as a single, endless
 * column of unconnected nodes, thousands of pixels tall and one card wide. The
 * mechanism to fix that already existed — `lib/agent-groups.ts` derives groups
 * from launch edges, lets the user edit them, and persists the arrangement to a
 * committable `.sapiom/studio-rail.json`. The map simply never read it.
 *
 * So this module invents nothing. It takes the rows the rail renders and
 * answers one question: which graph node is which row's. Everything about what
 * a group IS — derived until touched, `groups: null` is not `groups: []`,
 * membership is many-to-many — stays in `agent-groups.ts`, unmodified, and
 * reaches the map only through the `GroupNode[]` it is handed.
 */

/**
 * Containers for one graph, in the rail's own order, covering every node.
 *
 * `navigation` is the SAME map the drill-in uses (`system-graph-navigation.ts`):
 * public graph nodes carry no filesystem path, so the server-owned sidecar
 * joins an agent key to its workflow path for one exact graph revision.
 * Reusing that join rather than recreating identity resolution in the browser
 * keeps one invariant true — a node you can open is a node whose group is
 * known — and puts unresolved nodes in `Ungrouped` rather than in a guess.
 */
export function systemGraphNodeGroups(
  nodes: readonly SystemGraphNode[],
  groups: readonly GroupNode[],
  navigation: ReadonlyMap<AgentKey, string>,
): SystemGraphNodeGroup[] {
  const nodeIdByAgentKey = new Map(nodes.map((node) => [node.agentKey, node.id]));
  const nodeIdByPath = new Map<string, string>();
  for (const [agentKey, workflowPath] of navigation) {
    const nodeId = nodeIdByAgentKey.get(agentKey);
    if (nodeId !== undefined) nodeIdByPath.set(workflowPath, nodeId);
  }

  const claimed = new Set<string>();
  const containers: SystemGraphNodeGroup[] = [];
  for (const group of groups) {
    const nodeIds: string[] = [];
    for (const agent of group.agents) {
      const nodeId = nodeIdByPath.get(agent.workflow.path);
      // Claimed already: a shared subagent is a member of every system that
      // calls it, and the rail prints it once per group. The map has one card
      // for it, filed under the first group that names it.
      if (nodeId === undefined || claimed.has(nodeId)) continue;
      claimed.add(nodeId);
      nodeIds.push(nodeId);
    }
    // A group whose members are all agents this graph does not have would draw
    // an empty box with a name on it — chrome around nothing.
    if (nodeIds.length > 0) {
      containers.push({
        id: group.id,
        label: group.label,
        nodeIds,
        // Carried from the rail, never inferred from the label: a user may name
        // a group of their own "Ungrouped", and that group is a real system, not
        // the bucket for what nothing claims.
        isUngrouped: group.isUngrouped,
      });
    }
  }

  // Nodes no row claimed. Registry rows and graph nodes are two projections of
  // one directory and they can disagree — an agent registered a moment ago, one
  // whose key two rows both claim. Those are still on the map, and a bucket
  // named for what it means beats a card floating outside every container.
  const rest = nodes
    .map((node) => node.id)
    .filter((nodeId) => !claimed.has(nodeId));
  if (rest.length > 0) {
    const index = containers.findIndex((container) => container.isUngrouped);
    if (index === -1) {
      containers.push({
        id: UNGROUPED_ID,
        label: SYSTEM_GRAPH_UNGROUPED_LABEL,
        nodeIds: rest,
        isUngrouped: true,
      });
    } else {
      // Re-appended rather than edited in place: Ungrouped is last in the rail
      // and stays last here, so the two read in the same order.
      const bucket = containers[index]!;
      containers.splice(index, 1);
      containers.push({ ...bucket, nodeIds: [...bucket.nodeIds, ...rest] });
    }
  }
  return containers;
}
