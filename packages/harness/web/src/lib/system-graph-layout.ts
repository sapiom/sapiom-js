import type {
  AgentInvocationMode,
  SystemGraph,
  SystemGraphNode,
} from "@shared/system-graph";

import {
  groupSystemGraphEdges,
  type VisibleSystemGraphEdge,
} from "./system-graph";

export const SYSTEM_GRAPH_NODE_WIDTH = 184;
export const SYSTEM_GRAPH_NODE_HEIGHT = 64;
export const SYSTEM_GRAPH_RANK_GAP = 48;
export const SYSTEM_GRAPH_SLOT_GAP = 12;

const COMPONENT_GAP = 64;
const LAYOUT_PADDING = 32;
const PORT_LIMIT = 24;
const PORT_STEP = 8;
const LABEL_HEIGHT = 16;
const ISOLATED_SECTION_LABEL_GAP = 12;

/**
 * Inside a container, around everything it holds.
 *
 * Not a taste number: a cycle gutter reaches `8 + 9 * 4 = 44px` past the right
 * edge of its component and a rank-skipping corridor reaches `12 + 4 * 4 = 28px`
 * above the top of one. Anything smaller and a group's own wiring would be
 * drawn crossing the border drawn around it, which reads as an edge leaving the
 * system when it never did.
 */
const GROUP_PADDING = 48;
/**
 * The label strip along the top of a container, above its content.
 *
 * Sized for the BIGGEST line the label can produce, not for its natural one:
 * `.system-graph-group-label` grows its type up to 4x as the view zooms out, so
 * at the clamp it is `4 * --type-meta * 1.2` plus the container's own top
 * padding. Sized for the natural line instead, the name of a system would sit
 * across the first row of its cards at exactly the zoom it becomes readable.
 */
const GROUP_HEADER = 64;
/** Between containers. Wider than `COMPONENT_GAP` so the boundary between two
 *  systems reads as a bigger break than the boundary between two components of
 *  one system. */
const GROUP_GAP = 80;
/**
 * Target width:height for a packed region.
 *
 * The defect this whole file's packing exists to fix is a project of 76 agents
 * with 8 edges rendering as a single ~70-node column roughly 8,700px tall.
 * Shelf packing needs a width to wrap at, and the pane it lands in is wide, so
 * aim landscape rather than square.
 */
const SHELF_ASPECT = 2.2;

/**
 * The label for the bucket this module synthesizes when a node reaches it that
 * no container claimed — see `toRegions`. It matches the rail's own spelling
 * (`agent-groups.ts`), repeated rather than imported because the dependency
 * runs the other way: `system-graph-groups.ts` maps the rail's model onto this
 * one. The e2e spec asserts the map's labels against the RAIL's rows, so the
 * two spellings cannot drift apart unnoticed.
 *
 * It is a LABEL, never an identity test: `isUngrouped` is how the bucket is
 * recognised.
 */
export const SYSTEM_GRAPH_UNGROUPED_LABEL = "Ungrouped";

export interface SystemGraphPoint {
  x: number;
  y: number;
}

/**
 * One container to draw: a named set of node ids.
 *
 * The map does not decide these. They come from the Group axis the rail already
 * renders (`lib/agent-groups.ts`, mapped by `lib/system-graph-groups.ts`) — two
 * views of one arrangement, which is the whole point of SAP-2983. A second
 * opinion about which agents belong together would be a second answer to a
 * question the user has already answered.
 */
export interface SystemGraphNodeGroup {
  id: string;
  label: string;
  nodeIds: readonly string[];
  /**
   * The bucket for agents no group claims, carried by IDENTITY rather than
   * inferred from the label. Nothing stops a user creating or renaming a group
   * to "Ungrouped" in the rail, and matching on the string would then file
   * unresolved cards inside that named system and move it to the end of the
   * map — breaking the rail-order agreement this whole feature is about.
   */
  isUngrouped: boolean;
}

/** A drawn container: the box, and the label that names it. */
export interface SystemGraphLayoutGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
}

export interface SystemGraphLayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  componentId: string;
  /** The container this card sits inside, or null when the graph was laid out
   *  without groups. */
  groupId: string | null;
}

export interface SystemGraphLabelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SystemGraphLayoutEdge {
  from: string;
  to: string;
  modes: AgentInvocationMode[];
  path: string;
  points: SystemGraphPoint[];
  label: string;
  labelX: number;
  labelY: number;
  labelBounds: SystemGraphLabelBounds;
  route: "forward" | "cycle";
  /** True when the two ends sit in different containers. Drawn differently,
   *  because "these two systems touch" is a different claim from "this system
   *  is wired like this". */
  crossesGroup: boolean;
}

export interface SystemGraphIsolatedSection {
  /** The group whose isolated cards this label describes, or null when the
   *  graph was laid out without group information. */
  groupId: string | null;
  count: number;
  label: string;
  labelBounds: SystemGraphLabelBounds;
}

export interface SystemGraphLayout {
  nodes: SystemGraphLayoutNode[];
  edges: SystemGraphLayoutEdge[];
  /** Empty when laid out without groups — the map draws no chrome it was not
   *  given a reason to draw. */
  groups: SystemGraphLayoutGroup[];
  /** One labelled grid per region that contains globally degree-zero agents. */
  isolatedSections: SystemGraphIsolatedSection[];
  bounds: { width: number; height: number };
}

export interface SystemGraphStrongComponent {
  id: string;
  nodeIds: string[];
  rank: number;
}

export interface SystemGraphWeakComponent {
  id: string;
  nodeIds: string[];
  stronglyConnected: SystemGraphStrongComponent[];
  connected: boolean;
}

export interface SystemGraphTopology {
  components: SystemGraphWeakComponent[];
}

interface WorkGuard {
  step(): void;
}

interface ComponentBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface EdgeSeed {
  edge: VisibleSystemGraphEdge;
  route: "forward" | "cycle";
  componentId: string;
  sourceOffset: number;
  targetOffset: number;
  cycleLane: number;
  forwardLane: number;
  crossesGroup: boolean;
}

interface RoutedEdge extends EdgeSeed {
  points: SystemGraphPoint[];
  label: string;
  labelX: number;
  labelY: number;
  labelBounds: SystemGraphLabelBounds;
}

const compareIds = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const round = (value: number): number => Math.round(value * 100) / 100;

function makeGuard(nodeCount: number, edgeCount: number): WorkGuard {
  const limit = Math.max(128, (nodeCount + edgeCount + 1) * 96);
  let work = 0;
  return {
    step(): void {
      work += 1;
      if (work > limit) {
        throw new Error("System graph layout exceeded its finite work budget");
      }
    },
  };
}

function validateGraph(graph: SystemGraph): void {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id || ids.has(node.id)) {
      throw new Error("Invalid system graph layout input");
    }
    ids.add(node.id);
  }
  if (graph.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) {
    throw new Error("Invalid system graph layout input");
  }
}

function sortedAdjacency(
  nodeIds: readonly string[],
  edges: readonly VisibleSystemGraphEdge[],
): {
  directed: Map<string, string[]>;
  undirected: Map<string, string[]>;
} {
  const directedSets = new Map(nodeIds.map((id) => [id, new Set<string>()]));
  const undirectedSets = new Map(nodeIds.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    directedSets.get(edge.from)!.add(edge.to);
    undirectedSets.get(edge.from)!.add(edge.to);
    undirectedSets.get(edge.to)!.add(edge.from);
  }
  const toSorted = (sets: Map<string, Set<string>>): Map<string, string[]> =>
    new Map(
      [...sets.entries()].map(([id, values]) => [
        id,
        [...values].sort(compareIds),
      ]),
    );
  return {
    directed: toSorted(directedSets),
    undirected: toSorted(undirectedSets),
  };
}

function findWeakComponents(
  nodeIds: readonly string[],
  undirected: ReadonlyMap<string, readonly string[]>,
  guard: WorkGuard,
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const start of nodeIds) {
    guard.step();
    if (visited.has(start)) continue;
    const members: string[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      guard.step();
      const id = queue.shift()!;
      members.push(id);
      for (const neighbor of undirected.get(id) ?? []) {
        guard.step();
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    members.sort(compareIds);
    components.push(members);
  }
  return components;
}

function findStrongComponents(
  members: readonly string[],
  directed: ReadonlyMap<string, readonly string[]>,
  guard: WorkGuard,
): string[][] {
  const memberSet = new Set(members);
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];
  let nextIndex = 0;

  const visit = (id: string): void => {
    guard.step();
    indexById.set(id, nextIndex);
    lowById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of directed.get(id) ?? []) {
      guard.step();
      if (!memberSet.has(target)) continue;
      if (!indexById.has(target)) {
        visit(target);
        lowById.set(id, Math.min(lowById.get(id)!, lowById.get(target)!));
      } else if (onStack.has(target)) {
        lowById.set(id, Math.min(lowById.get(id)!, indexById.get(target)!));
      }
    }

    if (lowById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      guard.step();
      const popped = stack.pop()!;
      onStack.delete(popped);
      component.push(popped);
      if (popped === id) break;
    }
    component.sort(compareIds);
    result.push(component);
  };

  for (const id of members) {
    if (!indexById.has(id)) visit(id);
  }
  return result.sort((left, right) => compareIds(left[0]!, right[0]!));
}

function rankStrongComponents(
  strong: readonly string[][],
  edges: readonly VisibleSystemGraphEdge[],
  guard: WorkGuard,
): SystemGraphStrongComponent[] {
  const strongIds = strong.map((members) => `scc:${members[0]}`);
  const strongByNode = new Map<string, string>();
  strong.forEach((members, index) => {
    for (const id of members) strongByNode.set(id, strongIds[index]!);
  });
  const outgoing = new Map(strongIds.map((id) => [id, new Set<string>()]));
  const indegree = new Map(strongIds.map((id) => [id, 0]));
  for (const edge of edges) {
    guard.step();
    const from = strongByNode.get(edge.from);
    const to = strongByNode.get(edge.to);
    if (!from || !to || from === to || outgoing.get(from)!.has(to)) continue;
    outgoing.get(from)!.add(to);
    indegree.set(to, indegree.get(to)! + 1);
  }
  const rank = new Map(strongIds.map((id) => [id, 0]));
  const ready = strongIds
    .filter((id) => indegree.get(id) === 0)
    .sort(compareIds);
  let visited = 0;
  while (ready.length > 0) {
    guard.step();
    const id = ready.shift()!;
    visited += 1;
    for (const target of [...outgoing.get(id)!].sort(compareIds)) {
      guard.step();
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort(compareIds);
      }
    }
  }
  if (visited !== strong.length) {
    throw new Error("System graph SCC condensation was not acyclic");
  }
  return strong
    .map((nodeIds, index) => ({
      id: strongIds[index]!,
      nodeIds: [...nodeIds],
      rank: rank.get(strongIds[index]!)!,
    }))
    .sort(
      (left, right) => left.rank - right.rank || compareIds(left.id, right.id),
    );
}

export function analyzeSystemGraph(graph: SystemGraph): SystemGraphTopology {
  validateGraph(graph);
  const edges = groupSystemGraphEdges(graph.edges);
  const nodeIds = graph.nodes.map((node) => node.id).sort(compareIds);
  const guard = makeGuard(nodeIds.length, edges.length);
  const { directed, undirected } = sortedAdjacency(nodeIds, edges);
  const weak = findWeakComponents(nodeIds, undirected, guard);
  const components = weak.map((members): SystemGraphWeakComponent => {
    const memberSet = new Set(members);
    const componentEdges = edges.filter(
      (edge) => memberSet.has(edge.from) && memberSet.has(edge.to),
    );
    const stronglyConnected = rankStrongComponents(
      findStrongComponents(members, directed, guard),
      componentEdges,
      guard,
    );
    return {
      id: `component:${members[0]}`,
      nodeIds: [...members],
      stronglyConnected,
      connected: componentEdges.length > 0,
    };
  });
  components.sort(
    (left, right) =>
      Number(right.connected) - Number(left.connected) ||
      compareIds(left.id, right.id),
  );
  return { components };
}

interface Sized {
  width: number;
  height: number;
}

/**
 * Left-to-right shelves, wrapping at a width derived from the total area.
 *
 * Boxes keep their given ORDER — for containers that order is the rail's, and a
 * map that reshuffles the rail's rows is a map you have to re-read. Wrapping is
 * what stops a list of boxes becoming a column: stacking 68 single-agent
 * components produced a subject 8,700px tall, which no amount of fitting makes
 * legible.
 */
function shelfPack(
  sizes: readonly Sized[],
  gap: number,
): { offsets: SystemGraphPoint[]; width: number; height: number } {
  if (sizes.length === 0) return { offsets: [], width: 0, height: 0 };
  const widest = Math.max(...sizes.map((size) => size.width));
  // Each box is counted WITH its gutter, so the estimate holds for the many
  // small boxes case — which is the shape that produced the column.
  const area = sizes.reduce(
    (total, size) => total + (size.width + gap) * (size.height + gap),
    0,
  );
  const target = Math.max(widest, Math.sqrt(area * SHELF_ASPECT));
  const offsets: SystemGraphPoint[] = [];
  let shelfTop = 0;
  let shelfHeight = 0;
  let cursorX = 0;
  let width = 0;
  for (const size of sizes) {
    if (cursorX > 0 && cursorX + size.width > target) {
      shelfTop += shelfHeight + gap;
      shelfHeight = 0;
      cursorX = 0;
    }
    offsets.push({ x: cursorX, y: shelfTop });
    cursorX += size.width + gap;
    width = Math.max(width, cursorX - gap);
    shelfHeight = Math.max(shelfHeight, size.height);
  }
  return { offsets, width, height: shelfTop + shelfHeight };
}

/**
 * Every non-isolated component of one region, ranked internally and then
 * shelf-packed, followed by one wrapped grid for the region's isolated nodes.
 *
 * Isolation is classified against the WHOLE graph before regions are formed.
 * An agent whose only edge crosses a group boundary still has a detected
 * relationship and must never be filed under the isolated label.
 */
function placeRegionNodes(
  topology: SystemGraphTopology,
  groupId: string | null,
  globallyIsolatedNodeIds: ReadonlySet<string>,
): {
  nodes: SystemGraphLayoutNode[];
  componentBoxes: Map<string, ComponentBox>;
  componentByNode: Map<string, string>;
  strongByNode: Map<string, string>;
  isolatedSection: SystemGraphIsolatedSection | null;
  isolatedNodeIds: ReadonlySet<string>;
} {
  const componentByNode = new Map<string, string>();
  const strongByNode = new Map<string, string>();
  const isolatedNodes = topology.components
    .flatMap((component) =>
      component.stronglyConnected.flatMap((strong) =>
        strong.nodeIds
          .filter((id) => globallyIsolatedNodeIds.has(id))
          .map((id) => ({ id, component })),
      ),
    )
    .sort((left, right) => compareIds(left.id, right.id));
  const isolatedNodeIds = new Set(isolatedNodes.map((node) => node.id));
  // A degree-zero node is necessarily its own weak component, so removing its
  // component cannot disturb the ranked geometry of any connected component.
  const nonIsolatedComponents = topology.components.filter((component) =>
    component.nodeIds.some((id) => !isolatedNodeIds.has(id)),
  );
  const laid = nonIsolatedComponents.map((component) => {
    const byRank = new Map<number, string[]>();
    for (const strong of component.stronglyConnected) {
      const rankNodes = byRank.get(strong.rank) ?? [];
      rankNodes.push(...strong.nodeIds);
      rankNodes.sort(compareIds);
      byRank.set(strong.rank, rankNodes);
      for (const id of strong.nodeIds) {
        strongByNode.set(id, strong.id);
        componentByNode.set(id, component.id);
      }
    }
    const ranks = [...byRank.keys()].sort((left, right) => left - right);
    const rankHeight = (rank: number): number => {
      const count = byRank.get(rank)!.length;
      return (
        count * SYSTEM_GRAPH_NODE_HEIGHT +
        Math.max(0, count - 1) * SYSTEM_GRAPH_SLOT_GAP
      );
    };
    const height = Math.max(
      SYSTEM_GRAPH_NODE_HEIGHT,
      ...ranks.map(rankHeight),
    );
    const local: SystemGraphLayoutNode[] = [];
    for (const rank of ranks) {
      const rankNodes = byRank.get(rank)!;
      const startY = (height - rankHeight(rank)) / 2;
      rankNodes.forEach((id, row) => {
        local.push({
          id,
          x: rank * (SYSTEM_GRAPH_NODE_WIDTH + SYSTEM_GRAPH_RANK_GAP),
          y: startY + row * (SYSTEM_GRAPH_NODE_HEIGHT + SYSTEM_GRAPH_SLOT_GAP),
          width: SYSTEM_GRAPH_NODE_WIDTH,
          height: SYSTEM_GRAPH_NODE_HEIGHT,
          componentId: component.id,
          groupId,
        });
      });
    }
    const width = Math.max(...local.map((node) => node.x + node.width));
    return { component, local, width, height };
  });

  const packed = shelfPack(laid, COMPONENT_GAP);
  const nodes: SystemGraphLayoutNode[] = [];
  const componentBoxes = new Map<string, ComponentBox>();
  laid.forEach((entry, index) => {
    const at = packed.offsets[index]!;
    for (const node of entry.local) {
      nodes.push({ ...node, x: node.x + at.x, y: node.y + at.y });
    }
    // The ranked block spans its full box: the tallest rank starts at the top
    // and reaches the bottom, and rank 0 starts at the left.
    componentBoxes.set(entry.component.id, {
      minX: at.x,
      minY: at.y,
      maxX: at.x + entry.width,
      maxY: at.y + entry.height,
    });
  });

  let isolatedSection: SystemGraphIsolatedSection | null = null;
  if (isolatedNodes.length > 0) {
    const columnStride = SYSTEM_GRAPH_NODE_WIDTH + SYSTEM_GRAPH_SLOT_GAP;
    const rowStride = SYSTEM_GRAPH_NODE_HEIGHT + SYSTEM_GRAPH_SLOT_GAP;
    // Balance physical width and height (cards are much wider than tall) while
    // retaining the map's landscape packing target. Keep the decision
    // independent of the viewport so the layout is stable.
    const columns = Math.min(
      isolatedNodes.length,
      Math.max(
        2,
        Math.ceil(
          Math.sqrt(
            (isolatedNodes.length * rowStride * SHELF_ASPECT) / columnStride,
          ),
        ),
      ),
    );
    const gridWidth =
      columns * SYSTEM_GRAPH_NODE_WIDTH +
      Math.max(0, columns - 1) * SYSTEM_GRAPH_SLOT_GAP;
    const label = isolatedSectionLabel(isolatedNodes.length);
    const labelY = packed.height > 0 ? packed.height + COMPONENT_GAP : 0;
    const gridY = labelY + LABEL_HEIGHT + ISOLATED_SECTION_LABEL_GAP;

    isolatedNodes.forEach(({ id, component }, index) => {
      nodes.push({
        id,
        x: (index % columns) * columnStride,
        y: Math.floor(index / columns) * rowStride + gridY,
        width: SYSTEM_GRAPH_NODE_WIDTH,
        height: SYSTEM_GRAPH_NODE_HEIGHT,
        componentId: component.id,
        groupId,
      });
    });
    isolatedSection = {
      groupId,
      count: isolatedNodes.length,
      label,
      labelBounds: {
        x: 0,
        y: labelY,
        width: Math.max(gridWidth, labelWidth(label)),
        height: LABEL_HEIGHT,
      },
    };
  }

  nodes.sort((left, right) => compareIds(left.id, right.id));
  return {
    nodes,
    componentBoxes,
    componentByNode,
    strongByNode,
    isolatedSection,
    isolatedNodeIds,
  };
}

function spreadPortOffsets(
  seeds: EdgeSeed[],
  nodeById: ReadonlyMap<string, SystemGraphLayoutNode>,
  end: "source" | "target",
): void {
  const groups = new Map<string, EdgeSeed[]>();
  for (const seed of seeds) {
    const nodeId = end === "source" ? seed.edge.from : seed.edge.to;
    const side = end === "source" || seed.route === "cycle" ? "right" : "left";
    const key = `${nodeId}:${side}`;
    groups.set(key, [...(groups.get(key) ?? []), seed]);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const leftOther = nodeById.get(
        end === "source" ? left.edge.to : left.edge.from,
      )!;
      const rightOther = nodeById.get(
        end === "source" ? right.edge.to : right.edge.from,
      )!;
      return (
        leftOther.y - rightOther.y ||
        leftOther.x - rightOther.x ||
        compareIds(left.edge.from, right.edge.from) ||
        compareIds(left.edge.to, right.edge.to)
      );
    });
    const step =
      group.length <= 1
        ? 0
        : Math.min(PORT_STEP, (PORT_LIMIT * 2) / (group.length - 1));
    group.forEach((seed, index) => {
      const offset = round((index - (group.length - 1) / 2) * step);
      if (end === "source") seed.sourceOffset = offset;
      else seed.targetOffset = offset;
    });
  }
}

function labelForModes(modes: readonly AgentInvocationMode[]): string {
  return modes.length === 2 ? "blocking + async" : modes[0]!;
}

function isolatedSectionLabel(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"} · no detected relationships`;
}

function labelWidth(label: string): number {
  return Math.max(40, label.length * 6.5 + 8);
}

function overlaps(
  left: SystemGraphLabelBounds,
  right: SystemGraphLabelBounds,
  margin = 0,
): boolean {
  return !(
    left.x + left.width + margin <= right.x ||
    right.x + right.width + margin <= left.x ||
    left.y + left.height + margin <= right.y ||
    right.y + right.height + margin <= left.y
  );
}

function chooseLabelBounds(
  routed: Omit<RoutedEdge, "labelX" | "labelY" | "labelBounds">,
  nodeById: ReadonlyMap<string, SystemGraphLayoutNode>,
  allNodes: readonly SystemGraphLayoutNode[],
  existing: readonly SystemGraphLabelBounds[],
  componentBox: ComponentBox,
): SystemGraphLabelBounds {
  const source = nodeById.get(routed.edge.from)!;
  const target = nodeById.get(routed.edge.to)!;
  const width = labelWidth(routed.label);
  const start = routed.points[0]!;
  const end = routed.points.at(-1)!;
  const middleX = (start.x + end.x) / 2;
  const top = Math.min(source.y, target.y);
  const bottom = Math.max(source.y + source.height, target.y + target.height);
  const corridorX = routed.points[1]?.x ?? middleX;
  const targetLabelX =
    routed.route === "cycle"
      ? target.x + target.width / 2
      : target.x - width / 2 - 8;
  const candidates: SystemGraphPoint[] = [
    { x: targetLabelX, y: target.y - LABEL_HEIGHT / 2 - 4 },
    { x: targetLabelX, y: target.y + target.height + LABEL_HEIGHT / 2 + 4 },
    { x: corridorX, y: top - LABEL_HEIGHT / 2 - 4 },
    { x: corridorX, y: bottom + LABEL_HEIGHT / 2 + 4 },
    { x: middleX, y: top - LABEL_HEIGHT / 2 - 4 },
    { x: middleX, y: bottom + LABEL_HEIGHT / 2 + 4 },
  ];
  const nodeBounds = allNodes.map(
    (node): SystemGraphLabelBounds => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }),
  );
  const available = candidates
    .map(
      (center): SystemGraphLabelBounds => ({
        x: center.x - width / 2,
        y: center.y - LABEL_HEIGHT / 2,
        width,
        height: LABEL_HEIGHT,
      }),
    )
    .find(
      (candidate) =>
        !nodeBounds.some((node) => overlaps(candidate, node, 2)) &&
        !existing.some((label) => overlaps(candidate, label, 2)),
    );
  if (available) return available;

  const centerX = (componentBox.minX + componentBox.maxX - width) / 2;
  const fallbackSlots = (allNodes.length + existing.length + 1) * 6;
  for (let slot = 0; slot < fallbackSlots; slot += 1) {
    for (const y of [
      componentBox.minY - LABEL_HEIGHT - 8 - slot * (LABEL_HEIGHT + 4),
      componentBox.maxY + 8 + slot * (LABEL_HEIGHT + 4),
    ]) {
      const candidate = { x: centerX, y, width, height: LABEL_HEIGHT };
      if (
        !nodeBounds.some((node) => overlaps(candidate, node, 2)) &&
        !existing.some((label) => overlaps(candidate, label, 2))
      ) {
        return candidate;
      }
    }
  }
  throw new Error("System graph labels exceeded their finite placement budget");
}

function routeEdges(
  visible: readonly VisibleSystemGraphEdge[],
  nodes: readonly SystemGraphLayoutNode[],
  componentBoxes: ReadonlyMap<string, ComponentBox>,
  componentByNode: ReadonlyMap<string, string>,
  strongByNode: ReadonlyMap<string, string>,
  labels: SystemGraphLabelBounds[],
): RoutedEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const seeds: EdgeSeed[] = visible.map((edge) => {
    const componentId = componentByNode.get(edge.from)!;
    return {
      edge,
      route:
        strongByNode.get(edge.from) === strongByNode.get(edge.to)
          ? "cycle"
          : "forward",
      componentId,
      sourceOffset: 0,
      targetOffset: 0,
      cycleLane: 0,
      forwardLane: 0,
      crossesGroup: false,
    };
  });
  spreadPortOffsets(seeds, nodeById, "source");
  spreadPortOffsets(seeds, nodeById, "target");
  const cycleGroups = new Map<string, EdgeSeed[]>();
  for (const seed of seeds.filter((candidate) => candidate.route === "cycle")) {
    const key = strongByNode.get(seed.edge.from)!;
    cycleGroups.set(key, [...(cycleGroups.get(key) ?? []), seed]);
  }
  for (const group of cycleGroups.values()) {
    group
      .sort(
        (left, right) =>
          compareIds(left.edge.from, right.edge.from) ||
          compareIds(left.edge.to, right.edge.to),
      )
      .forEach((seed, index) => {
        seed.cycleLane = index;
      });
  }

  const longForwardGroups = new Map<string, EdgeSeed[]>();
  for (const seed of seeds.filter((candidate) => {
    if (candidate.route !== "forward") return false;
    const source = nodeById.get(candidate.edge.from)!;
    const target = nodeById.get(candidate.edge.to)!;
    return (
      target.x - source.x > SYSTEM_GRAPH_NODE_WIDTH + SYSTEM_GRAPH_RANK_GAP
    );
  })) {
    longForwardGroups.set(seed.componentId, [
      ...(longForwardGroups.get(seed.componentId) ?? []),
      seed,
    ]);
  }
  for (const group of longForwardGroups.values()) {
    group
      .sort(
        (left, right) =>
          compareIds(left.edge.from, right.edge.from) ||
          compareIds(left.edge.to, right.edge.to),
      )
      .forEach((seed, index) => {
        seed.forwardLane = index;
      });
  }

  return seeds.map((seed): RoutedEdge => {
    const source = nodeById.get(seed.edge.from)!;
    const target = nodeById.get(seed.edge.to)!;
    const start = {
      x: source.x + source.width,
      y: source.y + source.height / 2 + seed.sourceOffset,
    };
    let points: SystemGraphPoint[];
    if (seed.route === "forward") {
      const end = {
        x: target.x - 1,
        y: target.y + target.height / 2 + seed.targetOffset,
      };
      const skipsRank =
        target.x - source.x > SYSTEM_GRAPH_NODE_WIDTH + SYSTEM_GRAPH_RANK_GAP;
      if (skipsRank) {
        // Crossing an occupied intermediate rank would draw through a card.
        // Reserve a quiet corridor just above this weak component instead;
        // modulo keeps even dense graphs inside the inter-component gutter.
        const lane = seed.forwardLane % 5;
        const sourceGutterX = source.x + source.width + 8 + lane * 4;
        const targetGutterX = target.x - 8 - lane * 4;
        const corridorY =
          componentBoxes.get(seed.componentId)!.minY - 12 - lane * 4;
        points = [
          start,
          { x: sourceGutterX, y: start.y },
          { x: sourceGutterX, y: corridorY },
          { x: targetGutterX, y: corridorY },
          { x: targetGutterX, y: end.y },
          end,
        ];
      } else {
        const elbowX = round(start.x + (target.x - start.x) * 0.32);
        points = [
          start,
          { x: elbowX, y: start.y },
          { x: elbowX, y: end.y },
          end,
        ];
      }
    } else {
      const endY =
        source.id === target.id && seed.targetOffset === seed.sourceOffset
          ? target.y + target.height / 2 - 12
          : target.y + target.height / 2 + seed.targetOffset;
      const end = { x: target.x + target.width + 1, y: endY };
      const gutterX =
        Math.max(source.x + source.width, target.x + target.width) +
        8 +
        (seed.cycleLane % 10) * 4;
      if (source.id === target.id) {
        const loopY = target.y - 12 - Math.floor(seed.cycleLane / 10) * 8;
        points = [
          start,
          { x: gutterX, y: start.y },
          { x: gutterX, y: loopY },
          { x: target.x + target.width + 4, y: loopY },
          { x: target.x + target.width + 4, y: end.y },
          end,
        ];
      } else {
        points = [
          start,
          { x: gutterX, y: start.y },
          { x: gutterX, y: end.y },
          end,
        ];
      }
    }
    points = points.map((point) => ({ x: round(point.x), y: round(point.y) }));
    const label = labelForModes(seed.edge.modes);
    const partial = { ...seed, points, label };
    const labelBounds = chooseLabelBounds(
      partial,
      nodeById,
      nodes,
      labels,
      componentBoxes.get(seed.componentId)!,
    );
    labels.push(labelBounds);
    return {
      ...partial,
      labelBounds,
      labelX: round(labelBounds.x + labelBounds.width / 2),
      labelY: round(labelBounds.y + labelBounds.height - 3),
    };
  });
}

/** How far outside a card a cross-container connector runs before it turns. */
const CROSS_GROUP_GUTTER = 16;
const CROSS_GROUP_LANE = 6;

/**
 * Connectors whose two ends sit in DIFFERENT containers.
 *
 * They exist because a group is editable: pull half a detected system into a
 * group of its own and the edge between the halves is still real. Dropping it
 * would make the map claim two systems never touch, which is the one thing an
 * edge is for.
 *
 * Routed after the containers are packed, in global coordinates, and
 * deliberately NOT confined to a gutter: a corridor wide enough to skirt every
 * container between two ends would dominate the drawing for the rarest edge on
 * it. They pass BEHIND cards, because the edge layer sits under the node layer
 * — a connector between two containers is drawn CROSSING the border rather than
 * clipped by it, which is what makes it read as a link out of the system.
 */
function routeCrossGroupEdges(
  visible: readonly VisibleSystemGraphEdge[],
  nodes: readonly SystemGraphLayoutNode[],
  labels: SystemGraphLabelBounds[],
): RoutedEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return visible.map((edge, index): RoutedEdge => {
    const source = nodeById.get(edge.from)!;
    const target = nodeById.get(edge.to)!;
    const lane = index % 6;
    const start = {
      x: source.x + source.width,
      y: source.y + source.height / 2,
    };
    const end = { x: target.x - 1, y: target.y + target.height / 2 };
    let points: SystemGraphPoint[];
    if (end.x - start.x > SYSTEM_GRAPH_RANK_GAP) {
      const elbowX = start.x + (end.x - start.x) * 0.5 + lane * CROSS_GROUP_LANE;
      points = [
        start,
        { x: elbowX, y: start.y },
        { x: elbowX, y: end.y },
        end,
      ];
    } else {
      // The target is level with or behind the source: leave to the right, run
      // above both cards, and come back down into the target's left edge.
      const outX = start.x + CROSS_GROUP_GUTTER + lane * CROSS_GROUP_LANE;
      const inX = end.x - CROSS_GROUP_GUTTER - lane * CROSS_GROUP_LANE;
      const overY =
        Math.min(source.y, target.y) -
        CROSS_GROUP_GUTTER -
        lane * CROSS_GROUP_LANE;
      points = [
        start,
        { x: outX, y: start.y },
        { x: outX, y: overY },
        { x: inX, y: overY },
        { x: inX, y: end.y },
        end,
      ];
    }
    points = points.map((point) => ({ x: round(point.x), y: round(point.y) }));
    const label = labelForModes(edge.modes);
    const partial = {
      edge,
      route: "forward" as const,
      componentId: "",
      sourceOffset: 0,
      targetOffset: 0,
      cycleLane: 0,
      forwardLane: 0,
      crossesGroup: true,
      points,
      label,
    };
    const labelBounds = chooseLabelBounds(partial, nodeById, nodes, labels, {
      minX: Math.min(source.x, target.x),
      minY: Math.min(source.y, target.y),
      maxX: Math.max(source.x + source.width, target.x + target.width),
      maxY: Math.max(source.y + source.height, target.y + target.height),
    });
    labels.push(labelBounds);
    return {
      ...partial,
      labelBounds,
      labelX: round(labelBounds.x + labelBounds.width / 2),
      labelY: round(labelBounds.y + labelBounds.height - 3),
    };
  });
}

function pathFromPoints(points: readonly SystemGraphPoint[]): string {
  if (points.length === 0) return "";
  const parts = [`M ${round(points[0]!.x)} ${round(points[0]!.y)}`];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    if (point.y === previous.y) parts.push(`H ${round(point.x)}`);
    else if (point.x === previous.x) parts.push(`V ${round(point.y)}`);
    else parts.push(`L ${round(point.x)} ${round(point.y)}`);
  }
  return parts.join(" ");
}

const translateNode = (
  node: SystemGraphLayoutNode,
  dx: number,
  dy: number,
): SystemGraphLayoutNode => ({
  ...node,
  x: round(node.x + dx),
  y: round(node.y + dy),
});

const translateRouted = (
  edge: RoutedEdge,
  dx: number,
  dy: number,
): RoutedEdge => ({
  ...edge,
  points: edge.points.map((point) => ({
    x: round(point.x + dx),
    y: round(point.y + dy),
  })),
  labelX: round(edge.labelX + dx),
  labelY: round(edge.labelY + dy),
  labelBounds: {
    ...edge.labelBounds,
    x: round(edge.labelBounds.x + dx),
    y: round(edge.labelBounds.y + dy),
  },
});

const translateIsolatedSection = (
  section: SystemGraphIsolatedSection,
  dx: number,
  dy: number,
): SystemGraphIsolatedSection => ({
  ...section,
  labelBounds: {
    ...section.labelBounds,
    x: round(section.labelBounds.x + dx),
    y: round(section.labelBounds.y + dy),
  },
});

/** Keep the explanatory label below every routed primitive without allowing
 * provisional isolated cards to influence edge-label placement. */
function placeIsolatedSectionBelowEdges(
  nodes: SystemGraphLayoutNode[],
  edges: readonly RoutedEdge[],
  isolatedSection: SystemGraphIsolatedSection | null,
  isolatedNodeIds: ReadonlySet<string>,
): {
  nodes: SystemGraphLayoutNode[];
  isolatedSection: SystemGraphIsolatedSection | null;
} {
  if (!isolatedSection || edges.length === 0) {
    return { nodes, isolatedSection };
  }
  let routedBottom = Number.NEGATIVE_INFINITY;
  for (const edge of edges) {
    for (const point of edge.points) {
      routedBottom = Math.max(routedBottom, point.y);
    }
    routedBottom = Math.max(
      routedBottom,
      edge.labelBounds.y + edge.labelBounds.height,
    );
  }
  const targetY = Math.max(
    isolatedSection.labelBounds.y,
    routedBottom + COMPONENT_GAP,
  );
  const dy = round(targetY - isolatedSection.labelBounds.y);
  if (dy === 0) return { nodes, isolatedSection };

  return {
    nodes: nodes.map((node) =>
      isolatedNodeIds.has(node.id) ? translateNode(node, 0, dy) : node,
    ),
    isolatedSection: translateIsolatedSection(isolatedSection, 0, dy),
  };
}

interface Region {
  id: string;
  /** null for the single implicit region of an ungrouped layout — the one case
   *  where nothing is drawn around the content. */
  label: string | null;
  nodeIds: string[];
  isUngrouped: boolean;
}

/**
 * The containers to draw, as an exhaustive partition of the graph's nodes.
 *
 * `undefined` groups means "no grouping information" — the graph is laid out as
 * one unlabelled region, exactly as before this existed. That is not the same
 * as an EMPTY group list, and the caller must keep them apart: the map is
 * handed groups only once the project's stored arrangement AND the launch edges
 * have landed, so a project mid-load never flashes an "Ungrouped" container
 * that then turns out to be wrong.
 */
function toRegions(
  graph: SystemGraph,
  groups: readonly SystemGraphNodeGroup[] | undefined,
): Region[] {
  const order = graph.nodes.map((node) => node.id);
  if (!groups) {
    return [{ id: "", label: null, nodeIds: order, isUngrouped: false }];
  }
  const known = new Set(order);
  const claimed = new Set<string>();
  const regions: Region[] = [];
  for (const group of groups) {
    const nodeIds: string[] = [];
    for (const id of group.nodeIds) {
      // Group membership is MANY-to-many — a shared subagent genuinely belongs
      // to every system that calls it — but a map draws each agent once. First
      // claim wins, in the rail's own order, so the card sits where the rail
      // first mentions it rather than in whichever container drew last.
      if (!known.has(id) || claimed.has(id)) continue;
      claimed.add(id);
      nodeIds.push(id);
    }
    // A group whose every member resolved to nothing is chrome around nothing.
    if (nodeIds.length > 0) {
      regions.push({
        id: group.id,
        label: group.label,
        nodeIds,
        isUngrouped: group.isUngrouped,
      });
    }
  }
  const leftover = order.filter((id) => !claimed.has(id));
  if (leftover.length > 0) {
    // `systemGraphNodeGroups` hands over an exhaustive partition, so this is a
    // backstop rather than a path — and deliberately not a throw. A node that
    // silently disappears from the map is worse than a node filed in the bucket
    // that means "nothing claims this".
    const bucket = regions.find((region) => region.isUngrouped);
    if (bucket) bucket.nodeIds.push(...leftover);
    else {
      regions.push({
        id: "group:unclaimed",
        label: SYSTEM_GRAPH_UNGROUPED_LABEL,
        nodeIds: leftover,
        isUngrouped: true,
      });
    }
  }
  return regions;
}

interface LaidRegion extends Sized {
  id: string;
  label: string | null;
  nodes: SystemGraphLayoutNode[];
  edges: RoutedEdge[];
  isolatedSection: SystemGraphIsolatedSection | null;
  insetX: number;
  insetY: number;
}

/**
 * One container, laid out in its OWN coordinates and measured afterwards.
 *
 * Measuring after routing is what makes the container honest: its box is the
 * union of its cards, its connectors and its connector labels, so nothing a
 * group draws can end up outside the border drawn around it. Sizing the box
 * from the cards alone would let a cycle gutter or a displaced label spill into
 * the neighbouring system.
 */
function layoutRegion(
  graph: SystemGraph,
  region: Region,
  globallyIsolatedNodeIds: ReadonlySet<string>,
): LaidRegion {
  const members = new Set(region.nodeIds);
  const subgraph: SystemGraph = {
    ...graph,
    nodes: graph.nodes.filter((node) => members.has(node.id)),
    edges: graph.edges.filter(
      (edge) => members.has(edge.from) && members.has(edge.to),
    ),
  };
  const placed = placeRegionNodes(
    analyzeSystemGraph(subgraph),
    region.label === null ? null : region.id,
    globallyIsolatedNodeIds,
  );
  const labels: SystemGraphLabelBounds[] = [];
  const connectedNodes = placed.nodes.filter(
    (node) => !placed.isolatedNodeIds.has(node.id),
  );
  const routed = routeEdges(
    groupSystemGraphEdges(subgraph.edges),
    connectedNodes,
    placed.componentBoxes,
    placed.componentByNode,
    placed.strongByNode,
    labels,
  );
  const settled = placeIsolatedSectionBelowEdges(
    placed.nodes,
    routed,
    placed.isolatedSection,
    placed.isolatedNodeIds,
  );

  const xs: number[] = [];
  const ys: number[] = [];
  for (const node of settled.nodes) {
    xs.push(node.x, node.x + node.width);
    ys.push(node.y, node.y + node.height);
  }
  for (const edge of routed) {
    for (const point of edge.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
    xs.push(edge.labelBounds.x, edge.labelBounds.x + edge.labelBounds.width);
    ys.push(edge.labelBounds.y, edge.labelBounds.y + edge.labelBounds.height);
  }
  if (settled.isolatedSection) {
    xs.push(
      settled.isolatedSection.labelBounds.x,
      settled.isolatedSection.labelBounds.x +
        settled.isolatedSection.labelBounds.width,
    );
    ys.push(
      settled.isolatedSection.labelBounds.y,
      settled.isolatedSection.labelBounds.y +
        settled.isolatedSection.labelBounds.height,
    );
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const contentWidth = round(Math.max(...xs) - minX);
  const contentHeight = round(Math.max(...ys) - minY);
  const labelled = region.label !== null;
  return {
    id: region.id,
    label: region.label,
    nodes: settled.nodes.map((node) => translateNode(node, -minX, -minY)),
    edges: routed.map((edge) => translateRouted(edge, -minX, -minY)),
    isolatedSection: settled.isolatedSection
      ? translateIsolatedSection(settled.isolatedSection, -minX, -minY)
      : null,
    insetX: labelled ? GROUP_PADDING : 0,
    insetY: labelled ? GROUP_PADDING + GROUP_HEADER : 0,
    width: labelled ? contentWidth + GROUP_PADDING * 2 : contentWidth,
    height: labelled
      ? contentHeight + GROUP_PADDING * 2 + GROUP_HEADER
      : contentHeight,
  };
}

function shiftLayout(
  nodes: SystemGraphLayoutNode[],
  edges: RoutedEdge[],
  groups: SystemGraphLayoutGroup[],
  isolatedSections: SystemGraphIsolatedSection[],
): SystemGraphLayout {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const node of nodes) {
    xs.push(node.x, node.x + node.width);
    ys.push(node.y, node.y + node.height);
  }
  for (const group of groups) {
    xs.push(group.x, group.x + group.width);
    ys.push(group.y, group.y + group.height);
  }
  for (const edge of edges) {
    for (const point of edge.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
    xs.push(edge.labelBounds.x, edge.labelBounds.x + edge.labelBounds.width);
    ys.push(edge.labelBounds.y, edge.labelBounds.y + edge.labelBounds.height);
  }
  for (const isolatedSection of isolatedSections) {
    xs.push(
      isolatedSection.labelBounds.x,
      isolatedSection.labelBounds.x + isolatedSection.labelBounds.width,
    );
    ys.push(
      isolatedSection.labelBounds.y,
      isolatedSection.labelBounds.y + isolatedSection.labelBounds.height,
    );
  }
  if (xs.length === 0 || ys.length === 0) {
    return {
      nodes: [],
      edges: [],
      groups: [],
      isolatedSections: [],
      bounds: { width: 0, height: 0 },
    };
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const dx = LAYOUT_PADDING - minX;
  const dy = LAYOUT_PADDING - minY;
  const shiftedNodes = nodes.map((node) => translateNode(node, dx, dy));
  const shiftedGroups = groups.map((group) => ({
    ...group,
    x: round(group.x + dx),
    y: round(group.y + dy),
  }));
  const shiftedEdges = edges.map((edge): SystemGraphLayoutEdge => {
    const moved = translateRouted(edge, dx, dy);
    return {
      from: moved.edge.from,
      to: moved.edge.to,
      modes: [...moved.edge.modes],
      path: pathFromPoints(moved.points),
      points: moved.points,
      label: moved.label,
      labelX: moved.labelX,
      labelY: moved.labelY,
      labelBounds: moved.labelBounds,
      route: moved.route,
      crossesGroup: moved.crossesGroup,
    };
  });
  return {
    nodes: shiftedNodes,
    edges: shiftedEdges,
    groups: shiftedGroups,
    isolatedSections: isolatedSections.map((section) =>
      translateIsolatedSection(section, dx, dy),
    ),
    bounds: {
      width: round(maxX - minX + LAYOUT_PADDING * 2),
      height: round(maxY - minY + LAYOUT_PADDING * 2),
    },
  };
}

export function layoutSystemGraph(
  graph: SystemGraph,
  groups?: readonly SystemGraphNodeGroup[],
): SystemGraphLayout {
  validateGraph(graph);
  if (graph.nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      groups: [],
      isolatedSections: [],
      bounds: { width: 0, height: 0 },
    };
  }
  const relatedNodeIds = new Set<string>();
  for (const edge of graph.edges) {
    relatedNodeIds.add(edge.from);
    relatedNodeIds.add(edge.to);
  }
  const globallyIsolatedNodeIds = new Set(
    graph.nodes.map((node) => node.id).filter((id) => !relatedNodeIds.has(id)),
  );
  const laid = toRegions(graph, groups).map((region) =>
    layoutRegion(graph, region, globallyIsolatedNodeIds),
  );
  const packed = shelfPack(laid, GROUP_GAP);

  const nodes: SystemGraphLayoutNode[] = [];
  const routed: RoutedEdge[] = [];
  const labels: SystemGraphLabelBounds[] = [];
  const boxes: SystemGraphLayoutGroup[] = [];
  const isolatedSections: SystemGraphIsolatedSection[] = [];
  laid.forEach((region, index) => {
    const at = packed.offsets[index]!;
    const dx = at.x + region.insetX;
    const dy = at.y + region.insetY;
    for (const node of region.nodes) nodes.push(translateNode(node, dx, dy));
    for (const edge of region.edges) {
      const moved = translateRouted(edge, dx, dy);
      routed.push(moved);
      labels.push(moved.labelBounds);
    }
    if (region.isolatedSection) {
      const moved = translateIsolatedSection(region.isolatedSection, dx, dy);
      isolatedSections.push(moved);
      labels.push(moved.labelBounds);
    }
    if (region.label !== null) {
      boxes.push({
        id: region.id,
        label: region.label,
        x: round(at.x),
        y: round(at.y),
        width: region.width,
        height: region.height,
        nodeCount: region.nodes.length,
      });
    }
  });
  nodes.sort((left, right) => compareIds(left.id, right.id));

  const groupOfNode = new Map(nodes.map((node) => [node.id, node.groupId]));
  const crossing = groupSystemGraphEdges(graph.edges).filter(
    (edge) => groupOfNode.get(edge.from) !== groupOfNode.get(edge.to),
  );
  routed.push(...routeCrossGroupEdges(crossing, nodes, labels));

  return shiftLayout(nodes, routed, boxes, isolatedSections);
}

export function systemGraphNodeById(
  graph: SystemGraph,
): ReadonlyMap<string, SystemGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}
