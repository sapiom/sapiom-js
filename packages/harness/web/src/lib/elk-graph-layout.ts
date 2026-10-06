import type { ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api";

/**
 * The project map's two-level layout (plans/agent-map-rebuild/design.md §5):
 * ELK `layered` inside each system, `rectpacking` at the fleet level, so every
 * system and loose agent is visible at once and the fleet is never one global
 * layered graph. One ELK call; coordinates come back in root space.
 */

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 72;
/** A node with a chip row is this much taller. */
export const NODE_CHIP_ROW = 24;
/** Room above a system's agents for its name. */
export const GROUP_HEADER = 32;
const GROUP_PADDING = 16;

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  id: string;
  from: string;
  to: string;
  /** Measured label box; absent when the edge draws bare. */
  label?: {
    text: string;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  };
}

export interface LayoutGroupInput {
  id: string;
  nodes: readonly LayoutNodeInput[];
  edges: readonly LayoutEdgeInput[];
}

export interface ElkLayoutInput {
  id: string;
  groups: readonly LayoutGroupInput[];
  /** Agents in no system. */
  nodes: readonly LayoutNodeInput[];
  options?: Record<string, string>;
}

export interface PlacedBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  path: string;
  label: { text: string; x: number; y: number } | null;
}

export interface MapLayout {
  groups: PlacedBox[];
  nodes: PlacedBox[];
  edges: PlacedEdge[];
  bounds: { width: number; height: number };
}

function requireLayout(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid ELK layout");
}
function finite(value: unknown): number {
  requireLayout(typeof value === "number" && Number.isFinite(value));
  return value;
}
const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function allNodes(input: ElkLayoutInput): LayoutNodeInput[] {
  return [...input.groups.flatMap((group) => group.nodes), ...input.nodes];
}

export function createElkGraph(input: ElkLayoutInput): ElkNode {
  const nodes = allNodes(input);
  const ids = [...nodes.map(({ id }) => id), ...input.groups.map(({ id }) => id)];
  requireLayout(input.id && ids.every(Boolean) && new Set(ids).size === ids.length);
  requireLayout(nodes.every((node) => finite(node.width) > 0 && finite(node.height) > 0));
  const edgeIds = input.groups.flatMap((group) => group.edges.map(({ id }) => id));
  requireLayout(new Set(edgeIds).size === edgeIds.length);
  for (const group of input.groups) {
    requireLayout(group.nodes.length > 0);
    const members = new Set(group.nodes.map(({ id }) => id));
    requireLayout(
      group.edges.every(
        (edge) =>
          members.has(edge.from) &&
          members.has(edge.to) &&
          edge.from !== edge.to &&
          (!edge.label ||
            (finite(edge.label.width) > 0 &&
              finite(edge.label.height) > 0 &&
              Number.isFinite(edge.label.offsetX) &&
              Number.isFinite(edge.label.offsetY))),
      ),
    );
  }
  const edge = (item: LayoutEdgeInput): ElkExtendedEdge => ({
    id: item.id,
    sources: [item.from],
    targets: [item.to],
    ...(item.label
      ? { labels: [{ text: item.label.text, width: item.label.width, height: item.label.height }] }
      : {}),
  });
  return {
    id: input.id,
    layoutOptions: {
      "elk.spacing.nodeNode": "32",
      "elk.padding": `[top=${GROUP_PADDING},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
      ...input.options,
      "elk.algorithm": "rectpacking",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
    },
    children: [
      ...[...input.groups].sort(byId).map((group) => ({
        id: group.id,
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "DOWN",
          "elk.edgeRouting": "ORTHOGONAL",
          "elk.randomSeed": "1",
          // Fan-out from one agent shares a trunk instead of drawing parallel lines.
          "elk.layered.mergeEdges": "true",
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          "elk.spacing.nodeNode": "40",
          "elk.layered.spacing.nodeNodeBetweenLayers": "72",
          "elk.spacing.edgeNode": "24",
          "elk.spacing.edgeLabel": "12",
          "elk.padding": `[top=${GROUP_HEADER + GROUP_PADDING},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
        },
        children: [...group.nodes].sort(byId).map((node) => ({ ...node })),
        edges: [...group.edges].sort(byId).map(edge),
      })),
      ...[...input.nodes].sort(byId).map((node) => ({ ...node })),
    ],
  };
}

const overlaps = (a: PlacedBox, b: PlacedBox) =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
const contains = (outer: PlacedBox, inner: PlacedBox) =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
  inner.y + inner.height <= outer.y + outer.height + 1e-6;

/** Validate ELK's answer against the request and project it to drawable boxes and paths. */
export function readElkGraph(input: ElkLayoutInput, graph: ElkNode): MapLayout {
  requireLayout(graph.id === input.id);
  const top = graph.children ?? [];
  requireLayout(top.length === input.groups.length + input.nodes.length);
  const points: ElkPoint[] = [];
  const place = (node: ElkNode, expected?: LayoutNodeInput): PlacedBox => {
    const box = {
      id: node.id,
      x: finite(node.x),
      y: finite(node.y),
      width: finite(node.width),
      height: finite(node.height),
    };
    if (expected) requireLayout(box.width === expected.width && box.height === expected.height);
    points.push({ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height });
    return box;
  };
  const expectedNodes = new Map(allNodes(input).map((node) => [node.id, node]));
  const expectedGroups = new Map(input.groups.map((group) => [group.id, group]));
  const groups: PlacedBox[] = [];
  const nodes: PlacedBox[] = [];
  const routed: Array<Omit<PlacedEdge, "path"> & { route: ElkPoint[] }> = [];
  const seen = new Set<string>();
  for (const child of top) {
    requireLayout(!seen.has(child.id));
    seen.add(child.id);
    const group = expectedGroups.get(child.id);
    if (!group) {
      const expected = expectedNodes.get(child.id);
      requireLayout(expected && !child.children?.length);
      nodes.push(place(child, expected));
      continue;
    }
    const groupBox = place(child);
    groups.push(groupBox);
    const members = child.children ?? [];
    requireLayout(members.length === group.nodes.length);
    const placedMembers = new Map<string, PlacedBox>();
    for (const member of members) {
      requireLayout(!seen.has(member.id) && group.nodes.some(({ id }) => id === member.id));
      seen.add(member.id);
      const box = place(member, expectedNodes.get(member.id));
      requireLayout(contains(groupBox, box));
      placedMembers.set(member.id, box);
      nodes.push(box);
    }
    const routes = child.edges ?? [];
    requireLayout(routes.length === group.edges.length);
    const expectedEdges = new Map(group.edges.map((edge) => [edge.id, edge]));
    for (const route of routes) {
      const edge = expectedEdges.get(route.id);
      const label = route.labels?.[0];
      requireLayout(
        edge &&
          route.sources.length === 1 &&
          route.sources[0] === edge.from &&
          route.targets.length === 1 &&
          route.targets[0] === edge.to &&
          route.sections?.length === 1 &&
          (edge.label
            ? route.labels?.length === 1 && label?.text === edge.label.text
            : !route.labels?.length),
      );
      expectedEdges.delete(route.id);
      const section = route.sections[0]!;
      const path = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
        (point) => ({ x: finite(point?.x), y: finite(point?.y) }),
      );
      requireLayout(
        path.every(
          (point, i) =>
            i === 0 ||
            Math.abs(point.x - path[i - 1]!.x) < 1e-6 ||
            Math.abs(point.y - path[i - 1]!.y) < 1e-6,
        ),
      );
      const onBoundary = (point: ElkPoint, id: string) => {
        const node = placedMembers.get(id)!;
        const x = point.x - node.x;
        const y = point.y - node.y;
        const epsilon = 1e-6;
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
      requireLayout(onBoundary(path[0]!, edge.from) && onBoundary(path[path.length - 1]!, edge.to));
      points.push(...path);
      let placedLabel: PlacedEdge["label"] = null;
      if (edge.label && label) {
        const x = finite(label.x);
        const y = finite(label.y);
        points.push({ x, y }, { x: x + edge.label.width, y: y + edge.label.height });
        placedLabel = { text: edge.label.text, x: x + edge.label.offsetX, y: y + edge.label.offsetY };
      }
      routed.push({ id: edge.id, from: edge.from, to: edge.to, label: placedLabel, route: path });
    }
    requireLayout(expectedEdges.size === 0);
  }
  requireLayout(nodes.length === expectedNodes.size);
  for (let i = 0; i < nodes.length; i++)
    for (const other of nodes.slice(i + 1)) requireLayout(!overlaps(nodes[i]!, other));
  const outer = [...groups, ...nodes.filter((node) => !groups.some((group) => contains(group, node)))];
  for (let i = 0; i < outer.length; i++)
    for (const other of outer.slice(i + 1)) requireLayout(!overlaps(outer[i]!, other));

  // Include label ink, routed bends and arrow/stroke clearance, even outside ELK's root box.
  const left = Math.min(0, ...points.map(({ x }) => x)) - 16;
  const topEdge = Math.min(0, ...points.map(({ y }) => y)) - 16;
  const shift = (box: PlacedBox): PlacedBox => ({ ...box, x: box.x - left, y: box.y - topEdge });
  return {
    groups: groups.map(shift),
    nodes: nodes.map(shift),
    edges: routed.map(({ route, ...edge }) => ({
      ...edge,
      path: route.map((point, i) => `${i ? "L" : "M"} ${point.x - left} ${point.y - topEdge}`).join(" "),
      label: edge.label ? { ...edge.label, x: edge.label.x - left, y: edge.label.y - topEdge } : null,
    })),
    bounds: {
      width: Math.max(0, ...points.map(({ x }) => x)) - left + 16,
      height: Math.max(0, ...points.map(({ y }) => y)) - topEdge + 16,
    },
  };
}
