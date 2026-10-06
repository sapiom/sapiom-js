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
import {
  agentRole,
  chipKind,
  chipLabel,
  deploymentLabel,
  foldChips,
  displayNames,
  edgeId,
  systemDisplayName,
  edgeTitle,
  type AgentMap,
  type MapAgent,
} from "../lib/project-map";
import { useAgentMapLayout } from "../lib/use-agent-map-layout";
import { NODE_WIDTH } from "../lib/elk-graph-layout";
import {
  GRAPH_DEFAULT_MIN_ZOOM,
  GRAPH_MAX_ZOOM,
  GRAPH_ZOOM_STEP,
  clampGraphZoom,
  fitGraphView,
  graphViewIntersectsViewport,
  panGraphViewWithKeyboard,
  resetGraphView,
  revealGraphRect,
  wheelGraphView,
  type GraphArrowKey,
  type GraphView,
  type GraphViewportStore,
  type GraphRect,
} from "../lib/graph-viewport";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";

/** The node's padding on each side, so chips fold inside its content box. */
const NODE_INSET_PX = 24;

interface AgentMapCanvasProps {
  viewportStore: GraphViewportStore;
  projectId: string;
  map: AgentMap;
  selectedSlug: string | null;
  onSelectNode: (slug: string, control: HTMLButtonElement) => void;
  /** Double click on a node: the map's "enter" gesture (flow-navigation.md
   *  4.4, Q7). Single click has already fired twice underneath, which only
   *  re-opens the same panel. */
  onEnterNode: (slug: string, control: HTMLButtonElement) => void;
}

/** A stable testid for an edge: its id joins with NULs, which a selector cannot hold. */
const edgeTestId = (id: string) => `agent-map-edge-${id.split("\u0000").filter(Boolean).join("--")}`;

function nodeLabel(agent: MapAgent, name: string, ref: string | undefined): string {
  return [
    name === agent.slug ? name : `${name} (${agent.slug})`,
    "agent",
    deploymentLabel(agent),
    agentRole(agent),
    agent.changedSinceRef ? `changed since ${ref ?? "HEAD"}` : null,
    agent.shared.length > 0 ? `shares ${agent.shared.map(chipLabel).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  origin: GraphView;
}

// Long authored chains must fit as a whole before the user chooses a closer view.
const AGENT_MAP_MIN_ZOOM = 0.001;

export function AgentMapCanvas({
  viewportStore,
  projectId,
  map,
  selectedSlug,
  onSelectNode,
  onEnterNode,
}: AgentMapCanvasProps): JSX.Element {
  const [view, setView] = useState<GraphView>(resetGraphView);
  const [minZoom, setMinZoom] = useState(GRAPH_DEFAULT_MIN_ZOOM);
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const computed = useAgentMapLayout(projectId, map, viewportRef);
  const dragRef = useRef<DragState | null>(null);
  const fittedProjectRef = useRef<string | null>(null);
  const followsUpdates = useRef(true);
  const markerId = `agent-map-arrow-${useId().replace(/:/g, "")}`;
  const layout = computed.layout;
  const names = useMemo(() => displayNames(map.agents), [map.agents]);
  const agentsBySlug = useMemo(
    () => new Map(map.agents.map((agent) => [agent.slug, agent])),
    [map.agents],
  );
  const systemsById = useMemo(
    () => new Map(map.systems.map((system) => [system.id, system])),
    [map.systems],
  );
  const edgesById = useMemo(
    () => new Map(map.edges.map((edge) => [edgeId(edge), edge])),
    [map.edges],
  );

  const commitView = useCallback(
    (next: GraphView | ((current: GraphView) => GraphView)) => {
      setView((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        // Only manual views need restoring. Auto-fit must keep following new
        // layouts and pane sizes after navigating away and back.
        if (followsUpdates.current) viewportStore.delete(projectId);
        else viewportStore.set(projectId, resolved);
        return resolved;
      });
    },
    [projectId, viewportStore],
  );

  const measureFit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return null;
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const root = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    return fitGraphView(
      layout.bounds,
      { width: rect.width, height: rect.height },
      Number.isFinite(root) ? root : 16,
      AGENT_MAP_MIN_ZOOM,
    );
  }, [layout]);

  const fit = useCallback((): void => {
    followsUpdates.current = true;
    const next = measureFit();
    if (!next) return;
    setMinZoom(next.minZoom);
    commitView({ zoom: Math.min(1, next.zoom), x: 0, y: 0 });
  }, [commitView, measureFit]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return;
    const measure = (): void => {
      const next = measureFit();
      if (!next) return;
      setMinZoom(next.minZoom);
      if (fittedProjectRef.current !== projectId) {
        fittedProjectRef.current = projectId;
        const saved = viewportStore.get(projectId);
        const restored = saved && {
          ...saved,
          zoom: clampGraphZoom(saved.zoom, next.minZoom, AGENT_MAP_MIN_ZOOM),
        };
        followsUpdates.current = true;
        if (
          restored &&
          graphViewIntersectsViewport(
            restored,
            layout.bounds,
            { width: viewport.clientWidth, height: viewport.clientHeight },
            layout.nodes,
          )
        ) {
          followsUpdates.current = false;
          commitView(restored);
          return;
        }
      }
      if (followsUpdates.current)
        commitView({ zoom: Math.min(1, next.zoom), x: 0, y: 0 });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [commitView, layout, measureFit, projectId, viewportStore]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent): void => {
      if ((event.target as Element | null)?.closest(".agent-map-controls"))
        return;
      event.preventDefault();
      followsUpdates.current = false;
      const rect = viewport.getBoundingClientRect();
      commitView((current) =>
        wheelGraphView(
          current,
          event.deltaY,
          {
            x: event.clientX - rect.left - rect.width / 2,
            y: event.clientY - rect.top - rect.height / 2,
          },
          minZoom,
          AGENT_MAP_MIN_ZOOM,
        ),
      );
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [commitView, minZoom]);

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
    if (event.clientX !== drag.x || event.clientY !== drag.y)
      followsUpdates.current = false;
    commitView({
      ...drag.origin,
      x: drag.origin.x + event.clientX - drag.x,
      y: drag.origin.y + event.clientY - drag.y,
    });
  };
  const finishPan = (): void => {
    dragRef.current = null;
    setPanning(false);
  };

  const revealNode = (node: GraphRect): void => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return;
    commitView((current) => {
      const next = revealGraphRect(
        current,
        layout.bounds,
        {
          width: viewport.clientWidth,
          height: viewport.clientHeight,
        },
        node,
      );
      if (next.x === current.x && next.y === current.y) return current;
      followsUpdates.current = false;
      return next;
    });
  };

  return (
    <div
      className="agent-map-canvas"
      data-testid="agent-map-canvas"
      data-layout-engine="elk"
      data-layout-state={computed.state}
    >
      <div
        ref={viewportRef}
        className={`agent-map-viewport${panning ? " is-panning" : ""}`}
        data-testid="agent-map-viewport"
        role="region"
        aria-label="Agent Map. Use arrow keys to pan and Tab to inspect nodes."
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          )
            return;
          event.preventDefault();
          followsUpdates.current = false;
          commitView((current) =>
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
        {!layout && (
          <EmptyState
            className="agent-map-state"
            testId={
              computed.state === "error"
                ? "agent-map-layout-error"
                : "agent-map-layout-loading"
            }
            icon={computed.state === "error" ? "TriangleAlert" : "Workflow"}
            title={
              computed.state === "error"
                ? "Agent Map couldn't be arranged"
                : "Arranging Agent Map…"
            }
            body={
              computed.state === "error"
                ? "Your map is safe. Try arranging it again."
                : undefined
            }
            cta={
              computed.state === "error" ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={computed.retry}
                >
                  Retry layout
                </button>
              ) : undefined
            }
          />
        )}
        <div
          className="agent-map-subject"
          data-testid="agent-map-subject"
          style={{
            width: layout?.bounds.width ?? 0,
            height: layout?.bounds.height ?? 0,
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          }}
          role="group"
          aria-hidden={!layout}
          aria-label="Agent architecture"
        >
          <svg
            className="agent-map-edges"
            width={layout?.bounds.width ?? 0}
            height={layout?.bounds.height ?? 0}
            viewBox={`0 0 ${layout?.bounds.width ?? 0} ${layout?.bounds.height ?? 0}`}
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
            {layout?.edges.map((placed) => {
              const edge = edgesById.get(placed.id);
              return (
                <g
                  key={placed.id}
                  className="agent-map-edge-group"
                  data-testid={edgeTestId(placed.id)}
                  data-edge-kind={edge?.kind}
                >
                  {edge && (
                    // One line stands for every connection between the pair.
                    <title>
                      {map.edges
                        .filter((other) => other.from === edge.from && other.to === edge.to)
                        .map(edgeTitle)
                        .join("\n")}
                    </title>
                  )}
                  {/* A wider transparent stroke, so hovering near the line
                      shows its label and its tooltip. */}
                  <path className="agent-map-edge-hit" d={placed.path} />
                  <path
                    className="agent-map-edge"
                    d={placed.path}
                    markerEnd={`url(#${markerId})`}
                  />
                  {placed.label && (
                    <text
                      className="agent-map-edge-label"
                      x={placed.label.x}
                      y={placed.label.y}
                      textAnchor="middle"
                    >
                      {placed.label.text}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {layout?.groups.map((placed) => {
            const system = systemsById.get(placed.id);
            if (!system) return null;
            return (
              <div
                key={placed.id}
                className="agent-map-system"
                data-testid={`map-system-${system.id}`}
                data-system-id={system.id}
                data-group={systemDisplayName(system, names)}
                data-name-source={system.nameSource}
                style={
                  {
                    left: placed.x,
                    top: placed.y,
                    width: placed.width,
                    height: placed.height,
                  } satisfies CSSProperties
                }
                role="group"
                aria-label={`System ${systemDisplayName(system, names)}, ${system.agents.length} agents`}
              >
                <span className="agent-map-system-name">
                  {systemDisplayName(system, names)}
                  <span className="agent-map-system-count">
                    {system.agents.length === 1 ? "1 agent" : `${system.agents.length} agents`}
                  </span>
                </span>
              </div>
            );
          })}
          {layout?.nodes.map((placed) => {
            const agent = agentsBySlug.get(placed.id);
            if (!agent) return null;
            const deployed = deploymentLabel(agent);
            const role = agentRole(agent);
            const selected = selectedSlug === agent.slug;
            const chips = foldChips(agent.shared, NODE_WIDTH - NODE_INSET_PX);
            // Every map-node name is user-authored. Keep the privacy marker
            // on a USER_NAMED_OBJECTS value.
            return (
              <div
                key={agent.slug}
                className="agent-map-node-wrap"
                style={
                  {
                    left: placed.x,
                    top: placed.y,
                    width: placed.width,
                    height: placed.height,
                  } satisfies CSSProperties
                }
                onFocus={() => revealNode(placed)}
              >
                <button
                  type="button"
                  className={`agent-map-node${selected ? " is-selected" : ""}`}
                  data-testid={`agent-map-node-${agent.slug}`}
                  data-node-id={agent.slug}
                  data-map-card="true"
                  data-node-kind="agent"
                  data-deployment-state={deployed?.toLowerCase()}
                  data-deploy-state={deployed ?? undefined}
                  data-changed={agent.changedSinceRef ? "true" : undefined}
                  title={agent.description || undefined}
                  {...trackingAttrs({ object: "agent" })}
                  aria-pressed={selected}
                  aria-label={nodeLabel(agent, names.get(agent.slug) ?? agent.slug, map.ref)}
                  onClick={(event) => onSelectNode(agent.slug, event.currentTarget)}
                  onDoubleClick={(event) => onEnterNode(agent.slug, event.currentTarget)}
                >
                  <span className="agent-map-node-heading">
                    {agent.changedSinceRef && (
                      <span
                        className="agent-map-node-changed"
                        data-testid={`map-node-changed-${agent.slug}`}
                        role="img"
                        aria-label={`Changed since ${map.ref ?? "HEAD"}`}
                        title={`Changed since ${map.ref ?? "HEAD"}`}
                      />
                    )}
                    <span className="agent-map-node-label" title={agent.slug}>
                      {names.get(agent.slug) ?? agent.slug}
                    </span>
                  </span>
                  {(deployed || role) && (
                    <span className="agent-map-node-meta">
                      {deployed && (
                        <span className="agent-map-deployment" data-deployment-state={deployed.toLowerCase()}>
                          {deployed}
                        </span>
                      )}
                      {deployed && role ? " · " : ""}
                      {role && <span data-testid="agent-map-node-role">{role}</span>}
                    </span>
                  )}
                  {agent.shared.length > 0 && (
                    <span className="agent-map-node-chips">
                      {chips.shown.map((chip) => (
                        <span
                          key={chip}
                          className="agent-map-chip"
                          data-testid={`map-chip-${agent.slug}-${chipLabel(chip)}`}
                          data-chip-kind={chipKind(chip) ?? undefined}
                          title={`Shared with another agent: ${chip}`}
                        >
                          {chipLabel(chip)}
                        </span>
                      ))}
                      {chips.folded.length > 0 && (
                        <span
                          className="agent-map-chip"
                          data-testid={`map-chip-${agent.slug}-more`}
                          title={chips.folded.map(chipLabel).join(", ")}
                        >
                          +{chips.folded.length}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div
          className="agent-map-controls"
          style={!layout ? { display: "none" } : undefined}
          role="group"
          aria-label="Agent Map view controls"
        >
          {computed.state !== "ready" && (
            <span className="agent-map-node-meta" role="status">
              Arranging…
            </span>
          )}
          <button
            type="button"
            className="theme-toggle"
            aria-label="Zoom out"
            onClick={() => {
              followsUpdates.current = false;
              commitView((current) => ({
                ...current,
                zoom: clampGraphZoom(
                  current.zoom - GRAPH_ZOOM_STEP,
                  minZoom,
                  AGENT_MAP_MIN_ZOOM,
                ),
              }));
            }}
          >
            <Icon name="ZoomOut" size={14} />
          </button>
          <button
            type="button"
            className="theme-toggle agent-map-zoom-reset"
            aria-label="Reset Agent Map view"
            onClick={() => {
              followsUpdates.current = false;
              commitView(resetGraphView());
            }}
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <button
            type="button"
            className="theme-toggle"
            aria-label="Zoom in"
            disabled={view.zoom >= GRAPH_MAX_ZOOM}
            onClick={() => {
              followsUpdates.current = false;
              commitView((current) => ({
                ...current,
                zoom: clampGraphZoom(
                  current.zoom + GRAPH_ZOOM_STEP,
                  minZoom,
                  AGENT_MAP_MIN_ZOOM,
                ),
              }));
            }}
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
