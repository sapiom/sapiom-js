/**
 * The project map as Studio draws it: `sapiom_dev_map`'s output, unchanged,
 * plus the pure helpers the pane needs (plans/agent-map-rebuild/design.md §5).
 * Nothing here decides what an agent or an edge is; the map tool does.
 */
import type {
  AgentMap,
  MapAgent,
  MapEdge,
  ProjectMapResponse,
} from "../../../src/shared/project-map";
import { samePath } from "./paths";

export type { AgentMap, MapAgent, MapEdge, ProjectMapResponse };

/** Working copy is no ref; anything else is a git ref the server checks out. */
export type MapRef = string | null;

/** A Jev label the map tool may attach (PR 4). Shown only when present. */
interface Labelled {
  value: string;
}

/** The agent's role, when the map tool labelled one. Plain text, never a colour. */
export function agentRole(agent: MapAgent): string | null {
  const role = (agent as MapAgent & { role?: Labelled }).role;
  return typeof role?.value === "string" && role.value.trim() ? role.value : null;
}

/** The edge's label, when the map tool labelled one; unlabelled edges draw bare. */
export function edgeLabel(edge: MapEdge): string | null {
  const label = (edge as MapEdge & { label?: Labelled }).label;
  return typeof label?.value === "string" && label.value.trim() ? label.value : null;
}

/**
 * The name a node shows: the agent's folder (`agents/intake` → `intake`). Fleets prefix
 * every slug with the fleet's name, which truncates on the card and repeats on every node;
 * the slug stays in the tooltip and the testids.
 */
export function agentDisplayName(agent: Pick<MapAgent, "slug" | "path">): string {
  const folder = agent.path.split("/").filter(Boolean).pop();
  return folder || agent.slug;
}

/**
 * The git ref the map draws, or null for the working copy. The tool names the working copy
 * "working" in a git project and leaves ref out elsewhere; both mean the folders on disk.
 */
export function drawnRef(map: Pick<AgentMap, "ref">): string | null {
  return map.ref && map.ref !== "working" ? map.ref : null;
}

/** Each agent's shown name; two agents whose folders share a name keep their full slugs. */
export function displayNames(agents: readonly Pick<MapAgent, "slug" | "path">[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agentDisplayName(agent), (counts.get(agentDisplayName(agent)) ?? 0) + 1);
  return new Map(
    agents.map((agent) => {
      const name = agentDisplayName(agent);
      return [agent.slug, (counts.get(name) ?? 0) > 1 ? agent.slug : name];
    }),
  );
}

/** A default-named system is named after its most-connected agent: show that agent's name. */
export function systemDisplayName(
  system: { name: string; nameSource: "file" | "default" },
  names: ReadonlyMap<string, string>,
): string {
  if (system.nameSource === "file") return system.name;
  return names.get(system.name) ?? system.name;
}

/** Stable id for an edge: one per (from, to, kind, event type). */
export function edgeId(edge: MapEdge): string {
  return [edge.from, edge.to, edge.kind, edge.eventType ?? ""].join("\u0000");
}

/** What an edge is, for its tooltip: the kind and, for events, the type. */
export function edgeTitle(edge: MapEdge): string {
  const what = edge.kind === "event" && edge.eventType ? `event ${edge.eventType}` : edge.kind;
  const where = edge.evidence[0];
  return where ? `${edge.from} → ${edge.to}: ${what} (${where.file}:${where.line})` : `${edge.from} → ${edge.to}: ${what}`;
}

/** The agent's folder on disk: the map's paths are POSIX and relative to its root. */
export function agentFolder(map: AgentMap, agent: MapAgent): string | null {
  if (!map.root) return null;
  if (!agent.path || agent.path === ".") return map.root;
  const separator = map.root.includes("\\") && !map.root.includes("/") ? "\\" : "/";
  const relative = separator === "/" ? agent.path : agent.path.replaceAll("/", "\\");
  return `${map.root.replace(/[\\/]+$/, "")}${separator}${relative}`;
}

/** The registry row for a map agent, matched by folder. */
export function workflowForAgent<T extends { path: string }>(
  map: AgentMap,
  agent: MapAgent,
  workflows: readonly T[],
): T | null {
  const folder = agentFolder(map, agent);
  return folder ? (workflows.find((workflow) => samePath(workflow.path, folder)) ?? null) : null;
}

/** Deployed or Draft from the map's `deployed`; null draws no badge. */
export function deploymentLabel(agent: MapAgent): "Deployed" | "Draft" | null {
  return agent.deployed === null ? null : agent.deployed ? "Deployed" : "Draft";
}

/** A short chip for a shared resource: `vault:SLACK_TOKEN` → `SLACK_TOKEN`. */
export function chipLabel(chip: string): string {
  const colon = chip.indexOf(":");
  return colon > 0 ? chip.slice(colon + 1) : chip;
}

export type ChipKind = "database" | "connector" | "vault";

/** What a shared resource is, from the map tool's prefix (`db:`, `connector:`, `vault:`). */
export function chipKind(chip: string): ChipKind | null {
  const prefix = chip.slice(0, Math.max(0, chip.indexOf(":")));
  return prefix === "db" ? "database" : prefix === "connector" ? "connector" : prefix === "vault" ? "vault" : null;
}

/** Average mono glyph width at the card's meta size, and a chip's fixed frame. */
const CHIP_GLYPH_PX = 6.6;
const CHIP_FRAME_PX = 18;

/**
 * Which chips fit on the card's one chip line; the rest fold into `+N`, whose
 * tooltip names them (AGENT-MAP.md "Chips"). The first chip always shows,
 * ellipsized if it must be, so a card never reads only `+N`. Measured in
 * glyphs, not pixels, so the fold is the same in every theme and at every zoom.
 */
export function foldChips(chips: readonly string[], widthPx: number): { shown: string[]; folded: string[] } {
  const width = (text: string) => text.length * CHIP_GLYPH_PX + CHIP_FRAME_PX;
  const shown: string[] = [];
  let used = 0;
  for (const [index, chip] of chips.entries()) {
    const rest = chips.length - index - 1;
    const needed = width(chipLabel(chip)) + (shown.length > 0 ? 4 : 0);
    const reserve = rest > 0 ? width(`+${rest}`) + 4 : 0;
    if (shown.length > 0 && used + needed + reserve > widthPx) break;
    shown.push(chip);
    used += needed;
  }
  return { shown, folded: chips.slice(shown.length) };
}

/**
 * The structure the layout depends on: which agents, in which systems, joined
 * by which edges, and which nodes carry a chip row (it changes their height).
 * A refresh that leaves this unchanged reuses the cached positions, so nothing
 * moves (design.md §5).
 */
export function mapStructureKey(map: AgentMap): string {
  const bySlug = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify({
    systems: map.systems
      .map((system) => [system.id, [...system.agents].sort(bySlug)] as const)
      .sort((a, b) => bySlug(a[0], b[0])),
    agents: map.agents
      .map((agent) => [agent.slug, agent.shared.length > 0] as const)
      .sort((a, b) => bySlug(a[0], b[0])),
    edges: map.edges.map(edgeId).sort(bySlug),
  });
}

/**
 * What the agent modal's Canvas asks the graph route to draw for one agent
 * (design.md M6, D74): its steps and its edges to other agents, from the map
 * at the ref it is drawn at. Null when the map does not hold the agent (an
 * agent new in the working copy while a ref is drawn): the board then comes
 * from the working copy alone.
 */
export interface CanvasMapRequest {
  map: {
    steps: MapAgent["steps"] | null;
    stepsUnavailable?: string;
    calls: Array<{ to: string; kind: string; fromStep?: string; label?: string }>;
    calledBy: Array<{ from: string; kind: string; label?: string }>;
  };
  atRef: boolean;
}

export function canvasMapFor(map: AgentMap, agentPath: string): CanvasMapRequest | null {
  const agent = map.agents.find((candidate) => {
    const folder = agentFolder(map, candidate);
    return folder !== null && samePath(folder, agentPath);
  });
  if (!agent) return null;
  const kindOf = (edge: MapEdge) =>
    edge.kind === "event" && edge.eventType ? `event ${edge.eventType}` : edge.kind;
  return {
    map: {
      steps: agent.steps ?? null,
      ...(agent.stepsUnavailable ? { stepsUnavailable: agent.stepsUnavailable } : {}),
      calls: map.edges
        .filter((edge) => edge.from === agent.slug && edge.to !== agent.slug)
        .map((edge) => {
          const text = edgeLabel(edge);
          return {
            to: edge.to,
            kind: kindOf(edge),
            ...(edge.fromStep ? { fromStep: edge.fromStep } : {}),
            ...(text ? { label: text } : {}),
          };
        }),
      calledBy: map.edges
        .filter((edge) => edge.to === agent.slug && edge.from !== agent.slug)
        .map((edge) => {
          const text = edgeLabel(edge);
          return { from: edge.from, kind: kindOf(edge), ...(text ? { label: text } : {}) };
        }),
    },
    atRef: drawnRef(map) !== null,
  };
}
