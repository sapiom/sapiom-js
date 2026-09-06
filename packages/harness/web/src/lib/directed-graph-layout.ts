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

/** Directional component layout, with deterministic cycle ranks and balanced component packing. */
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
  const neighbors = new Map(sorted.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    outgoing.get(edge.from)!.push(edge.to);
    neighbors.get(edge.from)!.add(edge.to);
    neighbors.get(edge.to)!.add(edge.from);
  }
  outgoing.forEach((targets) => targets.sort());
  // Tarjan SCCs: downstream nodes of a cycle retain their directional rank.
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (id: string): void => {
    indices.set(id, index);
    low.set(id, index++);
    stack.push(id);
    onStack.add(id);
    for (const target of outgoing.get(id)!) {
      if (!indices.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (onStack.has(target))
        low.set(id, Math.min(low.get(id)!, indices.get(target)!));
    }
    if (low.get(id) === indices.get(id)) {
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
      } while (member !== id);
      groups.push(group.sort());
    }
  };
  for (const id of sorted) if (!indices.has(id)) visit(id);
  const groupFor = new Map(
    groups.flatMap((group, i) => group.map((id) => [id, i] as const)),
  );
  const groupEdges = groups.map(() => new Set<number>());
  const incoming = groups.map(() => 0);
  for (const edge of edges) {
    const from = groupFor.get(edge.from)!;
    const to = groupFor.get(edge.to)!;
    if (from !== to && !groupEdges[from]!.has(to)) {
      groupEdges[from]!.add(to);
      incoming[to]! += 1;
    }
  }
  const ranks = groups.map(() => 0);
  const queue = groups.map((_, i) => i).filter((i) => incoming[i] === 0);
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of [...groupEdges[current]!].sort((a, b) => a - b)) {
      ranks[next] = Math.max(ranks[next]!, ranks[current]! + 1);
      if (--incoming[next]! === 0) queue.push(next);
    }
  }
  const unseen = new Set(sorted);
  const components: Array<{
    key: string;
    nodes: DirectedLayoutNode[];
    width: number;
    height: number;
  }> = [];
  for (const start of sorted) {
    if (!unseen.delete(start)) continue;
    const members: string[] = [];
    const pending = [start];
    while (pending.length) {
      const id = pending.pop()!;
      members.push(id);
      for (const neighbor of neighbors.get(id)!)
        if (unseen.delete(neighbor)) pending.push(neighbor);
    }
    const byRank = new Map<number, string[]>();
    for (const id of members.sort()) {
      const rank = ranks[groupFor.get(id)!]!;
      byRank.set(rank, [...(byRank.get(rank) ?? []), id]);
    }
    const tiles: Array<{
      nodes: DirectedLayoutNode[];
      width: number;
      height: number;
    }> = [];
    for (const [, rankMembers] of [...byRank.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      // Wide fan-outs and cycles also get compact ranks, rather than a tall column.
      const columns = Math.max(
        1,
        Math.ceil(
          Math.sqrt(
            (rankMembers.length * (NODE_HEIGHT + ROW_GAP)) /
              (NODE_WIDTH + ROW_GAP),
          ),
        ),
      );
      const rows = Math.ceil(rankMembers.length / columns);
      tiles.push({
        nodes: rankMembers.map((id, i) => ({
          id,
          x: (i % columns) * (NODE_WIDTH + ROW_GAP),
          y: Math.floor(i / columns) * (NODE_HEIGHT + ROW_GAP),
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        })),
        width: columns * (NODE_WIDTH + ROW_GAP) - ROW_GAP,
        height: rows * (NODE_HEIGHT + ROW_GAP) - ROW_GAP,
      });
    }
    // Wrap long directional chains into alternating rows. A hundred ranks in
    // one horizontal strip would technically fit, but look like an empty line.
    const rankWidth = Math.max(
      ...tiles.map((tile) => tile.width),
      Math.sqrt(
        tiles.reduce(
          (area, tile) =>
            area + (tile.width + RANK_GAP) * (tile.height + ROW_GAP),
          0,
        ) * 1.6,
      ),
    );
    const rows: Array<{
      tiles: Array<{ tile: (typeof tiles)[number]; x: number }>;
      width: number;
      height: number;
    }> = [];
    for (const tile of tiles) {
      let row = rows.at(-1);
      if (!row || row.width + RANK_GAP + tile.width > rankWidth) {
        row = { tiles: [], width: 0, height: 0 };
        rows.push(row);
      }
      const x = row.tiles.length ? row.width + RANK_GAP : 0;
      row.tiles.push({ tile, x });
      row.width = x + tile.width;
      row.height = Math.max(row.height, tile.height);
    }
    const width = Math.max(...rows.map((row) => row.width));
    const placed: DirectedLayoutNode[] = [];
    let y = 0;
    rows.forEach((row, rowIndex) => {
      for (const { tile, x } of row.tiles)
        for (const node of tile.nodes)
          placed.push({
            ...node,
            x:
              rowIndex % 2 === 0 ? x + node.x : width - x - node.x - node.width,
            y: y + node.y,
          });
      y += row.height + RANK_GAP;
    });
    components.push({ key: start, nodes: placed, width, height: y - RANK_GAP });
  }
  const gap = EDGE_INSET * 2;
  components.sort(
    (a, b) =>
      b.height * b.width - a.height * a.width || a.key.localeCompare(b.key),
  );
  const targetWidth = Math.max(
    0,
    ...components.map((c) => c.width),
    Math.sqrt(
      components.reduce(
        (area, c) => area + (c.width + gap) * (c.height + gap),
        0,
      ) * 1.6,
    ),
  );
  const laid: DirectedLayoutNode[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const component of components) {
    if (x > 0 && x + component.width > targetWidth) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    for (const node of component.nodes)
      laid.push({
        ...node,
        x: node.x + x + EDGE_INSET,
        y: node.y + y + EDGE_INSET,
      });
    x += component.width + gap;
    rowHeight = Math.max(rowHeight, component.height);
  }
  const byId = new Map(laid.map((node) => [node.id, node]));
  const routed = [...edges]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((edge): DirectedLayoutEdge => {
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      const vertical = from.x === to.x;
      const forward = vertical ? to.y > from.y : to.x > from.x;
      const startX = vertical
        ? from.x + from.width / 2
        : from.x + (forward ? from.width : 0);
      const startY = vertical
        ? from.y + (forward ? from.height : 0)
        : from.y + from.height / 2;
      const endX = vertical
        ? to.x + to.width / 2
        : to.x + (forward ? 0 : to.width);
      const endY = vertical
        ? to.y + (forward ? 0 : to.height)
        : to.y + to.height / 2;
      const bend = vertical ? (startY + endY) / 2 : (startX + endX) / 2;
      const path = vertical
        ? `M ${startX} ${startY} C ${startX} ${bend}, ${endX} ${bend}, ${endX} ${endY}`
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
