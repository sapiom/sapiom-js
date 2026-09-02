import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  MapChangeProposal,
  PlanNodeId,
  PlanNodeKind,
} from "@shared/agent-map";

import { layoutDirectedGraph } from "../lib/directed-graph-layout";
import {
  GRAPH_DEFAULT_MIN_ZOOM,
  GRAPH_MAX_ZOOM,
  GRAPH_ZOOM_STEP,
  clampGraphZoom,
  fitGraphView,
  panGraphViewWithKeyboard,
  resetGraphView,
  wheelGraphView,
  type GraphArrowKey,
  type GraphView,
} from "../lib/graph-viewport";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { Icon, type IconName } from "./Icon";

interface AgentMapCanvasProps {
  proposal: MapChangeProposal;
  selectedNodeId: PlanNodeId | null;
  onSelectNode: (nodeId: PlanNodeId) => void;
}

const KIND_ICON: Record<PlanNodeKind, IconName> = {
  agent: "Brain",
  subagent: "Workflow",
  resource: "Folder",
  connector: "Plug",
  artifact: "BookOpen",
};

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  origin: GraphView;
}

export function AgentMapCanvas({
  proposal,
  selectedNodeId,
  onSelectNode,
}: AgentMapCanvasProps): JSX.Element {
  const computed = useMemo(() => {
    try {
      return {
        failed: false,
        layout: layoutDirectedGraph(
          proposal.nodes,
          proposal.relationships.map((relationship) => ({
            id: relationship.id,
            from: relationship.fromNodeId,
            to: relationship.toNodeId,
            label: `${relationship.kind}${relationship.executionMode ? ` · ${relationship.executionMode}` : ""}`,
          })),
        ),
      } as const;
    } catch {
      return { failed: true, layout: null } as const;
    }
  }, [proposal.nodes, proposal.relationships]);
  const [view, setView] = useState<GraphView>(resetGraphView);
  const [minZoom, setMinZoom] = useState(GRAPH_DEFAULT_MIN_ZOOM);
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const fittedProposalRef = useRef<string | null>(null);
  const markerId = `agent-map-arrow-${useId().replace(/:/g, "")}`;
  const layout = computed.layout;
  const nodesById = useMemo(
    () => new Map(proposal.nodes.map((node) => [node.id, node])),
    [proposal.nodes],
  );

  const fit = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return;
    const rect = viewport.getBoundingClientRect();
    const root = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const next = fitGraphView(
      layout.bounds,
      { width: rect.width, height: rect.height },
      Number.isFinite(root) ? root : 16,
    );
    setMinZoom(next.minZoom);
    setView({ zoom: Math.min(1, next.zoom), x: 0, y: 0 });
  }, [layout]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return;
    const measure = (): void => {
      if (
        fittedProposalRef.current === proposal.id ||
        viewport.getBoundingClientRect().width <= 0
      )
        return;
      fittedProposalRef.current = proposal.id;
      fit();
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit, layout, proposal.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent): void => {
      if ((event.target as Element | null)?.closest(".agent-map-controls"))
        return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      setView((current) =>
        wheelGraphView(
          current,
          event.deltaY,
          {
            x: event.clientX - rect.left - rect.width / 2,
            y: event.clientY - rect.top - rect.height / 2,
          },
          minZoom,
        ),
      );
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [minZoom]);

  const startPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if ((event.target as Element).closest("button")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: view,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView({
      ...drag.origin,
      x: drag.origin.x + event.clientX - drag.x,
      y: drag.origin.y + event.clientY - drag.y,
    });
  };
  const finishPan = (): void => {
    dragRef.current = null;
    setPanning(false);
  };

  if (computed.failed || !layout) {
    return (
      <EmptyState
        className="system-graph-state"
        testId="agent-map-layout-error"
        icon="TriangleAlert"
        title="Agent Map couldn't be arranged"
        body="The proposal is safe. Retry after the next update."
      />
    );
  }

  return (
    <div className="agent-map-canvas" data-testid="agent-map-canvas">
      <div
        ref={viewportRef}
        className={`agent-map-viewport${panning ? " is-panning" : ""}`}
        data-testid="agent-map-viewport"
        role="region"
        aria-label="Proposed Agent Map. Use arrow keys to pan and Tab to inspect nodes."
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          )
            return;
          event.preventDefault();
          setView((current) =>
            panGraphViewWithKeyboard(current, event.key as GraphArrowKey),
          );
        }}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={finishPan}
        onPointerCancel={finishPan}
        onDoubleClick={(event) => {
          if (!(event.target as Element).closest("button")) fit();
        }}
      >
        <div
          className="agent-map-subject"
          data-testid="agent-map-subject"
          style={{
            width: layout.bounds.width,
            height: layout.bounds.height,
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          }}
          role="group"
          aria-label="Proposed architecture"
        >
          <svg
            className="agent-map-edges"
            width={layout.bounds.width}
            height={layout.bounds.height}
            viewBox={`0 0 ${layout.bounds.width} ${layout.bounds.height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={markerId}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="agent-map-arrow" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <g key={edge.id} data-testid={`agent-map-edge-${edge.id}`}>
                <path
                  className="agent-map-edge"
                  d={edge.path}
                  markerEnd={`url(#${markerId})`}
                />
                <text
                  className="system-graph-edge-label agent-map-edge-label"
                  x={edge.labelX}
                  y={edge.labelY}
                  textAnchor="middle"
                >
                  {edge.label}
                </text>
              </g>
            ))}
          </svg>
          {layout.nodes.map((placed) => {
            const node = nodesById.get(placed.id as PlanNodeId)!;
            const owner = node.ownerAgentId
              ? nodesById.get(node.ownerAgentId)
              : null;
            // Every map-node name is user-authored. Keep the privacy marker
            // on a USER_NAMED_OBJECTS value even when node.kind is not agent.
            return (
              <button
                key={node.id}
                type="button"
                className={`agent-map-node${selectedNodeId === node.id ? " is-selected" : ""}`}
                data-testid={`agent-map-node-${node.id}`}
                data-node-kind={node.kind}
                data-proposal-state="proposed"
                {...trackingAttrs({ object: "agent" })}
                style={
                  {
                    left: placed.x,
                    top: placed.y,
                    width: placed.width,
                    height: placed.height,
                  } satisfies CSSProperties
                }
                aria-pressed={selectedNodeId === node.id}
                aria-label={`${node.name}, ${node.kind}, Proposed`}
                onClick={() => onSelectNode(node.id)}
              >
                <span className="agent-map-node-heading">
                  <Icon name={KIND_ICON[node.kind]} size={14} />
                  <span className="system-graph-node-label">{node.name}</span>
                </span>
                <span className="system-graph-node-meta">
                  {node.kind} · Proposed
                  {owner ? ` · owned by ${owner.name}` : ""}
                </span>
              </button>
            );
          })}
        </div>
        <div
          className="system-graph-controls agent-map-controls"
          role="group"
          aria-label="Agent Map view controls"
        >
          <button
            type="button"
            className="theme-toggle"
            aria-label="Zoom out"
            onClick={() =>
              setView((current) => ({
                ...current,
                zoom: clampGraphZoom(current.zoom - GRAPH_ZOOM_STEP, minZoom),
              }))
            }
          >
            <Icon name="ZoomOut" size={14} />
          </button>
          <button
            type="button"
            className="theme-toggle system-graph-zoom-reset"
            aria-label="Reset Agent Map view"
            onClick={() => setView(resetGraphView())}
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <button
            type="button"
            className="theme-toggle"
            aria-label="Zoom in"
            disabled={view.zoom >= GRAPH_MAX_ZOOM}
            onClick={() =>
              setView((current) => ({
                ...current,
                zoom: clampGraphZoom(current.zoom + GRAPH_ZOOM_STEP, minZoom),
              }))
            }
          >
            <Icon name="ZoomIn" size={14} />
          </button>
          <button
            type="button"
            className="theme-toggle"
            aria-label="Fit Agent Map to view"
            onClick={fit}
          >
            <Icon name="Frame" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
