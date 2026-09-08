import { useEffect, useMemo, useState, type RefObject } from "react";
import type { MapChangeProposal } from "@shared/agent-map";
import {
  layoutDirectedGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  type DirectedGraphLayout,
  type DirectedGraphEdge,
} from "./directed-graph-layout";
import type { ElkLayoutEdge } from "./elk-graph-layout";
import { ElkLayoutWorker } from "./elk-layout-worker";

type MapLayout = "classic" | "elk";
const PREFERENCE = "sapiom-agent-map-layout";
function initialLayout(): MapLayout {
  const query = new URLSearchParams(window.location.search).get("mapLayout");
  if (query === "classic" || query === "elk") return query;
  try {
    return localStorage.getItem(PREFERENCE) === "elk" ? "elk" : "classic";
  } catch {
    return "classic";
  }
}

async function measureLabels(
  edges: readonly DirectedGraphEdge[],
  viewport: HTMLElement,
): Promise<ElkLayoutEdge[]> {
  await document.fonts.ready;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  const text = document.createElementNS(
    svg.namespaceURI,
    "text",
  ) as SVGTextElement;
  text.setAttribute("class", "system-graph-edge-label agent-map-edge-label");
  text.setAttribute("text-anchor", "middle");
  svg.append(text);
  viewport.append(svg);
  try {
    return edges.map((edge) => {
      text.textContent = edge.label;
      const box = text.getBBox(),
        padding = Number.parseFloat(getComputedStyle(text).strokeWidth) / 2 + 2;
      return {
        ...edge,
        labelWidth: box.width + padding * 2,
        labelHeight: box.height + padding * 2,
        labelOffsetX: padding - box.x,
        labelOffsetY: padding - box.y,
      };
    });
  } finally {
    svg.remove();
  }
}

export function useAgentMapLayout(
  proposal: MapChangeProposal,
  viewport: RefObject<HTMLDivElement | null>,
  visible: boolean,
) {
  const [mode, setMode] = useState<MapLayout>(initialLayout);
  const [worker] = useState(() => new ElkLayoutWorker());
  const geometry = JSON.stringify({
    nodes: proposal.nodes.map(({ id }) => ({
      id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: proposal.relationships.map((edge) => ({
      id: edge.id,
      from: edge.fromNodeId,
      to: edge.toNodeId,
      label: `${edge.kind}${edge.executionMode ? ` · ${edge.executionMode}` : ""}`,
    })),
  });
  const input = useMemo(
    () =>
      ({
        id: `${proposal.projectId}/${proposal.id}`,
        ...JSON.parse(geometry),
      }) as {
        id: string;
        nodes: { id: string; width: number; height: number }[];
        edges: DirectedGraphEdge[];
      },
    [proposal.projectId, proposal.id, geometry],
  );
  const classic = useMemo(() => {
    try {
      return layoutDirectedGraph(input.nodes, input.edges);
    } catch {
      return null;
    }
  }, [input]);
  const [result, setResult] = useState<{
    input: typeof input;
    layout: DirectedGraphLayout | null;
  } | null>(null);
  useEffect(() => () => worker.dispose(), [worker]);
  useEffect(() => {
    if (mode !== "elk" || !viewport.current || !visible) return;
    const controller = new AbortController();
    const element = viewport.current;
    void measureLabels(input.edges, element)
      .then(async (edges) => {
        controller.signal.throwIfAborted();
        const layout = await worker.layout(
          { ...input, edges },
          controller.signal,
        );
        if (!controller.signal.aborted) setResult({ input, layout });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = error instanceof Error ? error.message : "";
        console.warn(
          "Agent Map layout fallback:",
          /^(Invalid ELK layout|Layout (worker failed|timed out))$/.test(reason)
            ? reason
            : "Startup or measurement failed",
        );
        setResult({ input, layout: null });
      });
    return () => controller.abort();
  }, [input, mode, viewport, visible, worker]);
  const vertical = mode === "elk" && result?.input === input ? result : null;
  return {
    layout: vertical?.layout ?? classic,
    mode,
    state:
      mode === "classic" || vertical?.layout
        ? "ready"
        : vertical
          ? "fallback"
          : "loading",
    engine: vertical?.layout ? "elk" : "classic",
    setMode: (next: MapLayout) => {
      setMode(next);
      try {
        localStorage.setItem(PREFERENCE, next);
      } catch {
        /* browser storage may be disabled */
      }
      const url = new URL(window.location.href);
      if (url.searchParams.has("mapLayout")) {
        url.searchParams.set("mapLayout", next);
        window.history.replaceState(window.history.state, "", url);
      }
    },
  };
}
