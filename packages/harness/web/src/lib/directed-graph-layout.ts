export interface DirectedGraphNode {
  id: string;
}

export interface DirectedGraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface DirectedLayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DirectedLayoutEdge extends DirectedGraphEdge {
  path: string;
  labelX: number;
  labelY: number;
}

export interface DirectedGraphLayout {
  nodes: DirectedLayoutNode[];
  edges: DirectedLayoutEdge[];
  bounds: { width: number; height: number };
}

const NODE_WIDTH = 184;
const NODE_HEIGHT = 72;
const RANK_GAP = 112;
const ROW_GAP = 40;
const EDGE_INSET = 32;

/** Stable finite directed layout. Cycles collapse to one rank, never recurse forever. */
export function layoutDirectedGraph(
  nodes: readonly DirectedGraphNode[],
  edges: readonly DirectedGraphEdge[],
): DirectedGraphLayout {
  const ids = new Set(nodes.map((node) => node.id));
  if (
    ids.size !== nodes.length ||
    nodes.some((node) => !node.id) ||
    new Set(edges.map((edge) => edge.id)).size !== edges.length ||
    edges.some(
      (edge) =>
        !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to,
    )
  )
    throw new Error("Invalid directed graph layout input");

  const sorted = [...ids].sort();
  const outgoing = new Map(sorted.map((id) => [id, [] as string[]]));
  const incoming = new Map(sorted.map((id) => [id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
  }
  outgoing.forEach((targets) => targets.sort());
  const ranks = new Map(sorted.map((id) => [id, 0]));
  const queue = sorted.filter((id) => incoming.get(id) === 0);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited.add(id);
    for (const target of outgoing.get(id)!) {
      ranks.set(target, Math.max(ranks.get(target)!, ranks.get(id)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  // Remaining nodes belong to or descend from cycles. Keep their stable IDs
  // together after the acyclic frontier; topology stays readable and finite.
  const cycleRank = Math.max(0, ...ranks.values());
  for (const id of sorted) if (!visited.has(id)) ranks.set(id, cycleRank);

  const byRank = new Map<number, string[]>();
  for (const id of sorted) {
    const rank = ranks.get(id)!;
    byRank.set(rank, [...(byRank.get(rank) ?? []), id]);
  }
  const laid: DirectedLayoutNode[] = [];
  for (const [rank, members] of [...byRank.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    members.forEach((id, row) =>
      laid.push({
        id,
        x: EDGE_INSET + rank * (NODE_WIDTH + RANK_GAP),
        y: EDGE_INSET + row * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }),
    );
  }
  const byId = new Map(laid.map((node) => [node.id, node]));
  const routed = [...edges]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((edge): DirectedLayoutEdge => {
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      const startX = from.x + from.width;
      const startY = from.y + from.height / 2;
      const endX = to.x;
      const endY = to.y + to.height / 2;
      const bend = Math.max(startX + 36, (startX + endX) / 2);
      const backwards = endX <= startX;
      const path = backwards
        ? `M ${startX} ${startY} C ${startX + 56} ${startY - 56}, ${endX - 56} ${endY - 56}, ${endX} ${endY}`
        : `M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}`;
      return {
        ...edge,
        path,
        labelX: (startX + endX) / 2,
        labelY: (startY + endY) / 2 - 8,
      };
    });
  return {
    nodes: laid,
    edges: routed,
    bounds: {
      width: Math.max(
        320,
        ...laid.map((node) => node.x + node.width + EDGE_INSET),
      ),
      height: Math.max(
        240,
        ...laid.map((node) => node.y + node.height + EDGE_INSET),
      ),
    },
  };
}
