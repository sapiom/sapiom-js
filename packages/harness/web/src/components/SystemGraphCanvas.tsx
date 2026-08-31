import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { AgentKey, SystemGraph, WorkspaceKey } from "@shared/system-graph";

import {
  layoutSystemGraph,
  systemGraphNodeById,
  type SystemGraphLayoutNode,
  type SystemGraphNodeGroup,
} from "../lib/system-graph-layout";
import {
  SYSTEM_GRAPH_DEFAULT_MIN_ZOOM,
  SYSTEM_GRAPH_MAX_ZOOM,
  SYSTEM_GRAPH_ZOOM_STEP,
  clampSystemGraphZoom,
  createSystemGraphViewportStore,
  fitSystemGraphView,
  panSystemGraphViewWithKeyboard,
  resetSystemGraphView,
  revealSystemGraphRect,
  systemGraphViewIntersectsViewport,
  wheelSystemGraphView,
  type SystemGraphArrowKey,
  type SystemGraphView,
} from "../lib/system-graph-viewport";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";

const viewportStore = createSystemGraphViewportStore();
const PAN_THRESHOLD = 3;

interface SystemGraphCanvasProps {
  graph: SystemGraph;
  workspaceKey: WorkspaceKey;
  navigableAgentKeys: ReadonlySet<AgentKey>;
  /**
   * The containers to draw, from the rail's Group axis. `undefined` while the
   * project's stored arrangement is still in flight — NOT an empty list, which
   * would be a real answer ("nothing is grouped") and would flash a wrong one.
   */
  groups: readonly SystemGraphNodeGroup[] | undefined;
  onOpenAgent: (agentKey: AgentKey) => void;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startView: SystemGraphView;
  moved: boolean;
}

function edgeModeClass(modes: readonly string[]): string {
  if (modes.length === 2) return "is-combined";
  return modes[0] === "async" ? "is-async" : "is-blocking";
}

export function SystemGraphCanvas({
  graph,
  workspaceKey,
  navigableAgentKeys,
  groups,
  onOpenAgent,
}: SystemGraphCanvasProps): JSX.Element {
  const computed = useMemo(() => {
    try {
      return { layout: layoutSystemGraph(graph, groups), failed: false } as const;
    } catch {
      return { layout: null, failed: true } as const;
    }
  }, [graph, groups]);
  const layout = computed.layout;
  const graphNodes = useMemo(() => systemGraphNodeById(graph), [graph]);
  const [view, setView] = useState<SystemGraphView>(
    () => viewportStore.get(workspaceKey) ?? resetSystemGraphView(),
  );
  const [minZoom, setMinZoom] = useState(SYSTEM_GRAPH_DEFAULT_MIN_ZOOM);
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const markerId = `system-graph-arrow-${useId().replace(/:/g, "")}`;

  const commitView = useCallback(
    (
      next: SystemGraphView | ((current: SystemGraphView) => SystemGraphView),
    ): void => {
      setView((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        viewportStore.set(workspaceKey, resolved);
        return resolved;
      });
    },
    [workspaceKey],
  );

  const readViewportFit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return null;
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const viewportSize = { width: rect.width, height: rect.height };
    return {
      fit: fitSystemGraphView(
        layout.bounds,
        viewportSize,
        Number.isFinite(rootFontSize) ? rootFontSize : 16,
      ),
      viewport: viewportSize,
    };
  }, [layout]);

  const fitView = useCallback((): void => {
    const measured = readViewportFit();
    if (!measured) return;
    const { fit } = measured;
    setMinZoom(fit.minZoom);
    commitView({ zoom: fit.zoom, x: fit.x, y: fit.y });
  }, [commitView, readViewportFit]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return;
    const syncFloor = (): void => {
      const measured = readViewportFit();
      if (measured) setMinZoom(measured.fit.minZoom);
    };
    const existing = viewportStore.get(workspaceKey);
    const measured = readViewportFit();
    if (measured) {
      const { fit, viewport: viewportSize } = measured;
      setMinZoom(fit.minZoom);
      if (
        existing &&
        systemGraphViewIntersectsViewport(
          existing,
          layout.bounds,
          viewportSize,
          layout.nodes,
        )
      ) {
        setView(existing);
      } else {
        // The system-map reference never enlarges a small graph on arrival;
        // explicit Fit may zoom up later. Containment wins when 100% crops.
        const initial = { ...fit, zoom: Math.min(1, fit.zoom) };
        const initialView = { zoom: initial.zoom, x: 0, y: 0 };
        viewportStore.set(workspaceKey, initialView);
        setView(initialView);
      }
    }
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncFloor);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [layout, readViewportFit, workspaceKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".system-graph-controls")
      ) {
        return;
      }
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const pointer = {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2),
      };
      commitView((current) =>
        wheelSystemGraphView(current, event.deltaY, pointer, minZoom),
      );
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [commitView, minZoom]);

  const finishPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setPanning(false);
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, a")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startView: viewRef.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
    drag.moved = true;
    setPanning(true);
    commitView({
      ...drag.startView,
      x: drag.startView.x + dx,
      y: drag.startView.y + dy,
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown"
    ) {
      return;
    }
    event.preventDefault();
    commitView((current) =>
      panSystemGraphViewWithKeyboard(current, event.key as SystemGraphArrowKey),
    );
  };

  if (computed.failed || !layout) {
    return (
      <EmptyState
        className="system-graph-state"
        testId="system-graph-layout-error"
        icon="TriangleAlert"
        title="Couldn't lay out this workspace graph"
        body="The local graph was malformed, so Studio stopped before rendering unsafe geometry."
      />
    );
  }

  const revealNode = (node: SystemGraphLayoutNode): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    commitView((current) =>
      revealSystemGraphRect(
        current,
        layout.bounds,
        { width: rect.width, height: rect.height },
        node,
      ),
    );
  };

  return (
    <div className="system-graph-canvas" data-testid="system-graph-canvas">
      <div
        ref={viewportRef}
        className={"system-graph-viewport" + (panning ? " is-panning" : "")}
        data-testid="system-graph-viewport"
        role="region"
        aria-label="Workspace dependency graph. Use arrow keys to pan."
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPan}
        onPointerCancel={finishPan}
        onDoubleClick={(event) => {
          const target = event.target;
          if (
            !(target instanceof Element) ||
            !target.closest(".system-graph-node, button, a")
          ) {
            fitView();
          }
        }}
      >
        <div
          className="system-graph-subject"
          data-testid="system-graph-subject"
          data-semantic-zoom={view.zoom < 0.55 ? "far" : "near"}
          style={
            {
              width: layout.bounds.width,
              height: layout.bounds.height,
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
              // Published for the container labels, which counter-scale against
              // it so a system stays NAMED at the altitude you zoom out to read
              // its shape from (see .system-graph-group-label).
              "--system-graph-zoom": view.zoom,
            } as CSSProperties
          }
          role="group"
          aria-label="Workspace dependency graph"
        >
          {/* Behind the connectors and the cards, so an edge that leaves its
              system reads as crossing the boundary rather than being clipped by
              it. */}
          {layout.groups.map((group) => (
            <div
              key={group.id}
              className="system-graph-group"
              data-testid={`system-graph-group-${group.id}`}
              data-group-id={group.id}
              data-group-label={group.label}
              data-group-nodes={group.nodeCount}
              style={
                {
                  left: group.x,
                  top: group.y,
                  width: group.width,
                  height: group.height,
                } satisfies CSSProperties
              }
            >
              <span className="system-graph-group-label" title={group.label}>
                {group.label}
              </span>
            </div>
          ))}

          <svg
            className="system-graph-edges"
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
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="system-graph-arrow" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <g
                key={JSON.stringify([edge.from, edge.to])}
                data-testid={`system-graph-edge-${edge.from}-${edge.to}`}
              >
                <path
                  className={
                    `system-graph-edge ${edgeModeClass(edge.modes)}` +
                    (edge.crossesGroup ? " is-cross-group" : "")
                  }
                  d={edge.path}
                  markerEnd={`url(#${markerId})`}
                />
                <text
                  className="system-graph-edge-label"
                  x={edge.labelX}
                  y={edge.labelY}
                  textAnchor="middle"
                >
                  {edge.label}
                </text>
              </g>
            ))}
          </svg>

          {layout.isolatedSections.map((section) => (
            <p
              key={section.groupId ?? "implicit"}
              className="system-graph-isolated-label"
              data-testid="system-graph-isolated-label"
              data-group-id={section.groupId ?? undefined}
              style={
                {
                  left: section.labelBounds.x,
                  top: section.labelBounds.y,
                  width: section.labelBounds.width,
                  height: section.labelBounds.height,
                } satisfies CSSProperties
              }
            >
              {section.label}
            </p>
          ))}

          {layout.nodes.map((placed) => {
            const graphNode = graphNodes.get(placed.id)!;
            const navigable = navigableAgentKeys.has(graphNode.agentKey);
            const style = {
              left: placed.x,
              top: placed.y,
              width: placed.width,
              height: placed.height,
            } satisfies CSSProperties;
            const contents = (
              <>
                <span className="system-graph-node-label">
                  {graphNode.label}
                </span>
                <span className="system-graph-node-meta">agent</span>
              </>
            );
            return navigable ? (
              <button
                key={placed.id}
                type="button"
                className="system-graph-node is-navigable"
                data-testid={`system-graph-node-${graphNode.agentKey}`}
                data-agent-key={graphNode.agentKey}
                style={style}
                title={graphNode.label}
                aria-label={`Open ${graphNode.label}`}
                onFocus={() => revealNode(placed)}
                onClick={() => onOpenAgent(graphNode.agentKey)}
                {...trackingAttrs({ object: "agent" })}
              >
                {contents}
              </button>
            ) : (
              <div
                key={placed.id}
                className="system-graph-node"
                data-testid={`system-graph-node-${graphNode.agentKey}`}
                data-agent-key={graphNode.agentKey}
                style={style}
                title={graphNode.label}
                {...trackingAttrs({ object: "agent" })}
              >
                {contents}
              </div>
            );
          })}
        </div>

        <div
          className="system-graph-controls"
          data-testid="system-graph-controls"
          role="group"
          aria-label="Workspace graph view controls"
        >
          <button
            type="button"
            className="theme-toggle"
            data-testid="system-graph-zoom-out"
            aria-label="Zoom out"
            disabled={view.zoom <= minZoom}
            onClick={() =>
              commitView((current) => ({
                ...current,
                zoom: clampSystemGraphZoom(
                  current.zoom - SYSTEM_GRAPH_ZOOM_STEP,
                  minZoom,
                ),
              }))
            }
          >
            <Icon name="ZoomOut" size={14} />
          </button>
          <button
            type="button"
            className="theme-toggle system-graph-zoom-reset"
            data-testid="system-graph-zoom-reset"
            aria-label="Reset workspace graph view to 100%"
            disabled={view.zoom === 1 && view.x === 0 && view.y === 0}
            onClick={() => commitView(resetSystemGraphView())}
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <button
            type="button"
            className="theme-toggle"
            data-testid="system-graph-zoom-in"
            aria-label="Zoom in"
            disabled={view.zoom >= SYSTEM_GRAPH_MAX_ZOOM}
            onClick={() =>
              commitView((current) => ({
                ...current,
                zoom: clampSystemGraphZoom(
                  current.zoom + SYSTEM_GRAPH_ZOOM_STEP,
                  minZoom,
                ),
              }))
            }
          >
            <Icon name="ZoomIn" size={14} />
          </button>
          <button
            type="button"
            className="theme-toggle"
            data-testid="system-graph-fit"
            aria-label="Fit workspace graph to view"
            onClick={fitView}
          >
            <Icon name="Frame" size={14} />
          </button>
        </div>
      </div>

      {graph.warnings.length > 0 && (
        <p className="system-graph-warning" data-testid="system-graph-warning">
          {graph.warnings.length} static projection{" "}
          {graph.warnings.length === 1 ? "warning" : "warnings"}
        </p>
      )}
    </div>
  );
}
