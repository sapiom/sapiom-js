import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import {
  NODE_CHIP_ROW,
  NODE_HEIGHT,
  NODE_WIDTH,
  type ElkLayoutInput,
  type LayoutEdgeInput,
  type MapLayout,
} from "./elk-graph-layout";
import { ElkLayoutWorker } from "./elk-layout-worker";
import {
  edgeId,
  edgeLabel,
  mapStructureKey,
  type AgentMap,
} from "./project-map";

async function measureLabels(
  edges: readonly LayoutEdgeInput[],
  viewport: HTMLElement,
): Promise<LayoutEdgeInput[]> {
  if (!edges.some((edge) => edge.label)) return [...edges];
  await document.fonts.ready;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  const text = document.createElementNS(svg.namespaceURI, "text") as SVGTextElement;
  text.setAttribute("class", "agent-map-edge-label");
  text.setAttribute("text-anchor", "middle");
  svg.append(text);
  viewport.append(svg);
  try {
    return edges.map((edge) => {
      if (!edge.label) return edge;
      text.textContent = edge.label.text;
      const box = text.getBBox(),
        padding = Number.parseFloat(getComputedStyle(text).strokeWidth) / 2 + 2;
      return {
        ...edge,
        label: {
          text: edge.label.text,
          width: box.width + padding * 2,
          height: box.height + padding * 2,
          offsetX: padding - box.x,
          offsetY: padding - box.y,
        },
      };
    });
  } finally {
    svg.remove();
  }
}

/** The layout request for a map, before label measurement. Deterministic in the map. */
export function agentMapGeometry(projectId: string, map: AgentMap): ElkLayoutInput {
  const node = (slug: string) => {
    const agent = map.agents.find((candidate) => candidate.slug === slug);
    return {
      id: slug,
      width: NODE_WIDTH,
      height: NODE_HEIGHT + (agent && agent.shared.length > 0 ? NODE_CHIP_ROW : 0),
    };
  };
  const known = new Set(map.agents.map((agent) => agent.slug));
  const grouped = new Set(map.systems.flatMap((system) => system.agents));
  return {
    id: projectId,
    groups: map.systems.flatMap((system) => {
      // A slug the map lists in a system but not as an agent has no card.
      const members = new Set(system.agents.filter((slug) => known.has(slug)));
      if (members.size === 0) return [];
      return [{
        id: system.id,
        nodes: [...members].map(node),
        edges: map.edges
          // An agent calling itself has no line to draw between two cards.
          .filter((edge) => edge.from !== edge.to && members.has(edge.from) && members.has(edge.to))
          // One line per pair: two event types from intake to copilot are one hand-off on the map.
          .filter(
            (edge, index, all) =>
              all.findIndex((other) => other.from === edge.from && other.to === edge.to) === index,
          )
          .map((edge) => {
            const text = edgeLabel(edge);
            return {
              id: edgeId(edge),
              from: edge.from,
              to: edge.to,
              // Measured in the browser before layout; zeros are placeholders.
              ...(text ? { label: { text, width: 0, height: 0, offsetX: 0, offsetY: 0 } } : {}),
            };
          }),
      }];
    }),
    nodes: map.agents.filter((agent) => !grouped.has(agent.slug)).map((agent) => node(agent.slug)),
  };
}

export function quantizedMapAspect(
  width: number,
  height: number,
): number | null {
  return width > 0 && height > 0 && Number.isFinite(width / height)
    ? Math.max(0.25, Math.round((width / height) * 4) / 4)
    : null;
}

/**
 * Positions by the map's structure and the board's aspect: a refresh or a
 * remount with no structural change draws from here, so nothing moves.
 */
const positions = new Map<string, MapLayout>();
const POSITION_CACHE_LIMIT = 32;
function remember(key: string, layout: MapLayout): void {
  positions.delete(key);
  positions.set(key, layout);
  while (positions.size > POSITION_CACHE_LIMIT)
    positions.delete(positions.keys().next().value!);
}

export function useAgentMapLayout(
  projectId: string,
  map: AgentMap,
  viewport: RefObject<HTMLDivElement | null>,
) {
  const [worker] = useState(() => new ElkLayoutWorker());
  const [attempt, setAttempt] = useState(0);
  const [aspect, setAspect] = useState<number | null>(null);
  // Labels are part of the structure: a new label changes the geometry.
  const structure = `${projectId}\u0000${mapStructureKey(map)}\u0000${JSON.stringify(
    map.edges.map((edge) => edgeLabel(edge) ?? ""),
  )}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by structure, not identity
  const input = useMemo(() => agentMapGeometry(projectId, map), [structure]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      setAspect(quantizedMapAspect(element.clientWidth, element.clientHeight));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [viewport]);
  const cacheKey = aspect === null ? null : `${structure}\u0000${aspect}`;
  const [result, setResult] = useState<{
    key: string;
    attempt: number;
    layout: MapLayout | null;
  } | null>(null);
  useEffect(() => () => worker.dispose(), [worker]);
  useEffect(() => {
    if (!viewport.current || aspect === null || cacheKey === null) return;
    if (positions.has(cacheKey) && attempt === 0) return;
    const element = viewport.current;
    // An explicit layout request may precede the pending resize debounce.
    const measuredAspect = quantizedMapAspect(element.clientWidth, element.clientHeight);
    if (measuredAspect !== aspect) {
      setAspect(measuredAspect);
      return;
    }
    const controller = new AbortController();
    let measuring = true;
    void Promise.all(input.groups.map((group) => measureLabels(group.edges, element)))
      .then(async (measured) => {
        controller.signal.throwIfAborted();
        measuring = false;
        const layout = await worker.layout(
          {
            ...input,
            groups: input.groups.map((group, index) => ({ ...group, edges: measured[index]! })),
            options: { "elk.aspectRatio": String(aspect) },
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        remember(cacheKey, layout);
        setResult({ key: cacheKey, attempt, layout });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = error instanceof Error ? error.message : "";
        console.warn(
          "Agent Map layout failed:",
          /^(Invalid ELK layout|Layout (worker failed|timed out))$/.test(reason)
            ? reason
            : `${measuring ? "Label measurement" : worker.stage} failed`,
        );
        setResult({ key: cacheKey, attempt, layout: null });
      });
    return () => controller.abort();
  }, [input, aspect, cacheKey, attempt, viewport, worker]);
  const cached = cacheKey !== null && attempt === 0 ? positions.get(cacheKey) : undefined;
  const fresh = result?.key === cacheKey && result.attempt === attempt ? result : null;
  const layout = fresh ? fresh.layout : (cached ?? null);
  return {
    layout,
    state: layout ? "ready" : fresh ? "error" : "loading",
    retry: () => setAttempt((value) => value + 1),
  } as const;
}
