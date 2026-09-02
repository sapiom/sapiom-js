export const GRAPH_DEFAULT_MIN_ZOOM = 0.25;
export const GRAPH_FLOOR_ZOOM = 0.1;
export const GRAPH_MAX_ZOOM = 3;
export const GRAPH_ZOOM_STEP = 0.25;
export const GRAPH_WHEEL_RATE = 0.0015;
export const GRAPH_KEYBOARD_PAN_STEP = 48;

const FIT_EDGE_REM = 3.5;
const FIT_EDGE_AXIS_CAP = 0.2;
const FOCUS_REVEAL_INSET = 16;

export interface GraphSize {
  width: number;
  height: number;
}

export interface GraphView {
  zoom: number;
  x: number;
  y: number;
}

export interface GraphRect extends GraphSize {
  x: number;
  y: number;
}

export interface GraphFit extends GraphView {
  minZoom: number;
}

export interface GraphViewportStore {
  get(workspaceKey: string): GraphView | undefined;
  set(workspaceKey: string, view: GraphView): void;
}

const roundZoom = (zoom: number): number => Math.round(zoom * 100) / 100;

export function clampGraphZoom(
  zoom: number,
  minZoom = GRAPH_DEFAULT_MIN_ZOOM,
): number {
  return Math.min(
    GRAPH_MAX_ZOOM,
    Math.max(Math.max(GRAPH_FLOOR_ZOOM, minZoom), roundZoom(zoom)),
  );
}

export function fitGraphView(
  graph: GraphSize,
  viewport: GraphSize,
  rootFontSize: number,
): GraphFit {
  if (
    graph.width <= 0 ||
    graph.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return {
      zoom: 1,
      x: 0,
      y: 0,
      minZoom: GRAPH_DEFAULT_MIN_ZOOM,
    };
  }
  const preferred = FIT_EDGE_REM * rootFontSize;
  const insetX = Math.min(preferred, viewport.width * FIT_EDGE_AXIS_CAP);
  const insetY = Math.min(preferred, viewport.height * FIT_EDGE_AXIS_CAP);
  const fitted = Math.min(
    (viewport.width - insetX * 2) / graph.width,
    (viewport.height - insetY * 2) / graph.height,
    GRAPH_MAX_ZOOM,
  );
  const zoom = Math.max(
    GRAPH_FLOOR_ZOOM,
    Math.min(GRAPH_MAX_ZOOM, Math.floor(fitted * 100) / 100),
  );
  return {
    zoom,
    x: 0,
    y: 0,
    minZoom: Math.min(GRAPH_DEFAULT_MIN_ZOOM, zoom),
  };
}

export function resetGraphView(): GraphView {
  return { zoom: 1, x: 0, y: 0 };
}

export function graphViewIntersectsViewport(
  view: GraphView,
  graph: GraphSize,
  viewport: GraphSize,
  visibleRects: readonly GraphRect[] = [
    { x: 0, y: 0, width: graph.width, height: graph.height },
  ],
): boolean {
  if (
    !Number.isFinite(view.zoom) ||
    !Number.isFinite(view.x) ||
    !Number.isFinite(view.y) ||
    view.zoom <= 0 ||
    graph.width <= 0 ||
    graph.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return false;
  }
  return visibleRects.some((rect) => {
    const left =
      viewport.width / 2 + view.x + (rect.x - graph.width / 2) * view.zoom;
    const top =
      viewport.height / 2 + view.y + (rect.y - graph.height / 2) * view.zoom;
    return (
      left < viewport.width &&
      left + rect.width * view.zoom > 0 &&
      top < viewport.height &&
      top + rect.height * view.zoom > 0
    );
  });
}

export type GraphArrowKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown";

export function panGraphViewWithKeyboard(
  view: GraphView,
  key: GraphArrowKey,
): GraphView {
  switch (key) {
    case "ArrowLeft":
      return { ...view, x: view.x - GRAPH_KEYBOARD_PAN_STEP };
    case "ArrowRight":
      return { ...view, x: view.x + GRAPH_KEYBOARD_PAN_STEP };
    case "ArrowUp":
      return { ...view, y: view.y - GRAPH_KEYBOARD_PAN_STEP };
    case "ArrowDown":
      return { ...view, y: view.y + GRAPH_KEYBOARD_PAN_STEP };
  }
}

function revealAxisOffset(
  start: number,
  end: number,
  viewportStart: number,
  viewportEnd: number,
): number {
  if (end - start > viewportEnd - viewportStart) {
    return (viewportStart + viewportEnd - start - end) / 2;
  }
  if (start < viewportStart) return viewportStart - start;
  if (end > viewportEnd) return viewportEnd - end;
  return 0;
}

export function revealGraphRect(
  view: GraphView,
  graph: GraphSize,
  viewport: GraphSize,
  rect: GraphRect,
): GraphView {
  if (
    graph.width <= 0 ||
    graph.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    view.zoom <= 0
  ) {
    return { ...view };
  }
  const insetX = Math.min(FOCUS_REVEAL_INSET, viewport.width / 2);
  const insetY = Math.min(FOCUS_REVEAL_INSET, viewport.height / 2);
  const left =
    viewport.width / 2 + view.x + (rect.x - graph.width / 2) * view.zoom;
  const top =
    viewport.height / 2 + view.y + (rect.y - graph.height / 2) * view.zoom;
  const right = left + rect.width * view.zoom;
  const bottom = top + rect.height * view.zoom;
  return {
    ...view,
    x: view.x + revealAxisOffset(left, right, insetX, viewport.width - insetX),
    y: view.y + revealAxisOffset(top, bottom, insetY, viewport.height - insetY),
  };
}

export function zoomGraphAtPointer(
  view: GraphView,
  nextZoom: number,
  pointer: GraphPoint,
): GraphView {
  if (view.zoom <= 0 || nextZoom === view.zoom)
    return { ...view, zoom: nextZoom };
  const ratio = nextZoom / view.zoom;
  return {
    zoom: nextZoom,
    x: pointer.x - ratio * (pointer.x - view.x),
    y: pointer.y - ratio * (pointer.y - view.y),
  };
}

export interface GraphPoint {
  x: number;
  y: number;
}

export function wheelGraphView(
  view: GraphView,
  deltaY: number,
  pointer: GraphPoint,
  minZoom: number,
): GraphView {
  const zoom = clampGraphZoom(
    view.zoom * Math.exp(-deltaY * GRAPH_WHEEL_RATE),
    minZoom,
  );
  return zoomGraphAtPointer(view, zoom, pointer);
}

export function createGraphViewportStore(): GraphViewportStore {
  const saved = new Map<string, GraphView>();
  return {
    get(workspaceKey) {
      const value = saved.get(workspaceKey);
      return value ? { ...value } : undefined;
    },
    set(workspaceKey, value) {
      saved.set(workspaceKey, { ...value });
    },
  };
}
