import type { ElkNode, ElkPoint } from "elkjs/lib/elk-api";
import type {
  DirectedGraphEdge,
  DirectedGraphLayout,
} from "./directed-graph-layout";

export interface ElkLayoutEdge extends DirectedGraphEdge {
  labelWidth: number;
  labelHeight: number;
  labelOffsetX: number;
  labelOffsetY: number;
}
export interface ElkLayoutInput {
  id: string;
  nodes: readonly { id: string; width: number; height: number }[];
  edges: readonly ElkLayoutEdge[];
  options?: Record<string, string>;
}

function requireLayout(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid ELK layout");
}
function finite(value: unknown): number {
  requireLayout(typeof value === "number" && Number.isFinite(value));
  return value;
}
function unique(items: readonly { id: string }[]): void {
  requireLayout(
    items.every(({ id }) => id.length > 0) &&
      new Set(items.map(({ id }) => id)).size === items.length,
  );
}
const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function createElkGraph(input: ElkLayoutInput): ElkNode {
  unique(input.nodes);
  unique(input.edges);
  const ids = new Set(input.nodes.map(({ id }) => id));
  requireLayout(
    input.id &&
      input.nodes.every(
        (node) => finite(node.width) > 0 && finite(node.height) > 0,
      ),
  );
  requireLayout(
    input.edges.every(
      (edge) =>
        ids.has(edge.from) &&
        ids.has(edge.to) &&
        edge.from !== edge.to &&
        finite(edge.labelWidth) > 0 &&
        finite(edge.labelHeight) > 0 &&
        Number.isFinite(edge.labelOffsetX) &&
        Number.isFinite(edge.labelOffsetY),
    ),
  );
  return {
    id: input.id,
    layoutOptions: {
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.edgeLabel": "12",
      "elk.spacing.componentComponent": "24",
      "elk.separateConnectedComponents": "true",
      "elk.layered.compaction.connectedComponents": "true",
      ...input.options,
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.randomSeed": "1",
    },
    children: [...input.nodes].sort(byId).map((node) => ({ ...node })),
    edges: [...input.edges].sort(byId).map((edge) => ({
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
      labels: [
        { text: edge.label, width: edge.labelWidth, height: edge.labelHeight },
      ],
    })),
  };
}

export function readElkGraph(
  input: ElkLayoutInput,
  graph: ElkNode,
): DirectedGraphLayout {
  requireLayout(
    graph.id === input.id &&
      finite(graph.width) >= 0 &&
      finite(graph.height) >= 0,
  );
  const children = graph.children ?? [],
    routes = graph.edges ?? [];
  unique(children);
  unique(routes);
  requireLayout(
    children.length === input.nodes.length &&
      routes.length === input.edges.length,
  );
  const expectedNodes = new Map(input.nodes.map((node) => [node.id, node]));
  const expectedEdges = new Map(input.edges.map((edge) => [edge.id, edge]));
  const points: ElkPoint[] = [];
  const box = (x: number, y: number, width: number, height: number) => {
    points.push({ x, y }, { x: x + width, y: y + height });
  };
  const nodes = children.map((node) => {
    const expected = expectedNodes.get(node.id);
    requireLayout(
      expected &&
        node.width === expected.width &&
        node.height === expected.height,
    );
    const placed = {
      id: node.id,
      x: finite(node.x),
      y: finite(node.y),
      width: expected.width,
      height: expected.height,
    };
    box(placed.x, placed.y, placed.width, placed.height);
    return placed;
  });
  for (let i = 0; i < nodes.length; i++)
    for (const other of nodes.slice(i + 1)) {
      const node = nodes[i]!;
      requireLayout(
        node.x + node.width <= other.x ||
          other.x + other.width <= node.x ||
          node.y + node.height <= other.y ||
          other.y + other.height <= node.y,
      );
    }
  const placedNodes = new Map(nodes.map((node) => [node.id, node]));
  const onBoundary = (point: ElkPoint, id: string) => {
    const node = placedNodes.get(id)!;
    const x = point.x - node.x,
      y = point.y - node.y,
      epsilon = 1e-6;
    return (
      x >= -epsilon &&
      x <= node.width + epsilon &&
      y >= -epsilon &&
      y <= node.height + epsilon &&
      (Math.abs(x) < epsilon ||
        Math.abs(x - node.width) < epsilon ||
        Math.abs(y) < epsilon ||
        Math.abs(y - node.height) < epsilon)
    );
  };
  const edges = routes.map((route) => {
    const edge = expectedEdges.get(route.id),
      label = route.labels?.[0];
    requireLayout(
      edge &&
        route.sources.length === 1 &&
        route.sources[0] === edge.from &&
        route.targets.length === 1 &&
        route.targets[0] === edge.to &&
        route.sections?.length === 1 &&
        route.labels?.length === 1 &&
        label?.text === edge.label &&
        label.width === edge.labelWidth &&
        label.height === edge.labelHeight,
    );
    const section = route.sections[0]!;
    const path = [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ].map((point) => ({ x: finite(point?.x), y: finite(point?.y) }));
    requireLayout(
      path.every(
        (point, i) =>
          i === 0 ||
          Math.abs(point.x - path[i - 1]!.x) < 1e-6 ||
          Math.abs(point.y - path[i - 1]!.y) < 1e-6,
      ),
    );
    requireLayout(
      onBoundary(path[0]!, edge.from) &&
        onBoundary(path[path.length - 1]!, edge.to),
    );
    points.push(...path);
    const x = finite(label.x),
      y = finite(label.y);
    box(x, y, edge.labelWidth, edge.labelHeight);
    return {
      edge,
      path,
      labelX: x + edge.labelOffsetX,
      labelY: y + edge.labelOffsetY,
    };
  });
  // Include label ink, routed bends and arrow/stroke clearance, even outside ELK's root box.
  const left = Math.min(0, ...points.map(({ x }) => x)) - 16;
  const top = Math.min(0, ...points.map(({ y }) => y)) - 16;
  return {
    nodes: nodes.map((node) => ({
      ...node,
      x: node.x - left,
      y: node.y - top,
    })),
    edges: edges.map(({ edge, path, labelX, labelY }) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label,
      path: path
        .map(
          (point, i) => `${i ? "L" : "M"} ${point.x - left} ${point.y - top}`,
        )
        .join(" "),
      labelX: labelX - left,
      labelY: labelY - top,
    })),
    bounds: {
      width: Math.max(0, ...points.map(({ x }) => x)) - left + 16,
      height: Math.max(0, ...points.map(({ y }) => y)) - top + 16,
    },
  };
}
