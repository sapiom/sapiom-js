import type { WorkspaceKey } from "@shared/system-graph";

export const SYSTEM_GRAPH_DEFAULT_MIN_ZOOM = 0.25;
export const SYSTEM_GRAPH_FLOOR_ZOOM = 0.1;
export const SYSTEM_GRAPH_MAX_ZOOM = 3;
export const SYSTEM_GRAPH_ZOOM_STEP = 0.25;
export const SYSTEM_GRAPH_WHEEL_RATE = 0.0015;
export const SYSTEM_GRAPH_KEYBOARD_PAN_STEP = 48;

const FIT_EDGE_REM = 3.5;
const FIT_EDGE_AXIS_CAP = 0.2;
const FOCUS_REVEAL_INSET = 16;

export interface SystemGraphSize {
  width: number;
  height: number;
}

export interface SystemGraphView {
  zoom: number;
  x: number;
  y: number;
}

export interface SystemGraphRect extends SystemGraphSize {
  x: number;
  y: number;
}

export interface SystemGraphFit extends SystemGraphView {
  minZoom: number;
}

export interface SystemGraphViewportStore {
  get(workspaceKey: WorkspaceKey): SystemGraphView | undefined;
  set(workspaceKey: WorkspaceKey, view: SystemGraphView): void;
}

const roundZoom = (zoom: number): number => Math.round(zoom * 100) / 100;

export function clampSystemGraphZoom(
  zoom: number,
  minZoom = SYSTEM_GRAPH_DEFAULT_MIN_ZOOM,
): number {
  return Math.min(
    SYSTEM_GRAPH_MAX_ZOOM,
    Math.max(Math.max(SYSTEM_GRAPH_FLOOR_ZOOM, minZoom), roundZoom(zoom)),
  );
}

export function fitSystemGraphView(
  graph: SystemGraphSize,
  viewport: SystemGraphSize,
  rootFontSize: number,
): SystemGraphFit {
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
      minZoom: SYSTEM_GRAPH_DEFAULT_MIN_ZOOM,
    };
  }
  const preferred = FIT_EDGE_REM * rootFontSize;
  const insetX = Math.min(preferred, viewport.width * FIT_EDGE_AXIS_CAP);
  const insetY = Math.min(preferred, viewport.height * FIT_EDGE_AXIS_CAP);
  const fitted = Math.min(
    (viewport.width - insetX * 2) / graph.width,
    (viewport.height - insetY * 2) / graph.height,
    SYSTEM_GRAPH_MAX_ZOOM,
  );
  const zoom = Math.max(
    SYSTEM_GRAPH_FLOOR_ZOOM,
    Math.min(SYSTEM_GRAPH_MAX_ZOOM, Math.floor(fitted * 100) / 100),
  );
  return {
    zoom,
    x: 0,
    y: 0,
    minZoom: Math.min(SYSTEM_GRAPH_DEFAULT_MIN_ZOOM, zoom),
  };
}

export function resetSystemGraphView(): SystemGraphView {
  return { zoom: 1, x: 0, y: 0 };
}

export function systemGraphViewIntersectsViewport(
  view: SystemGraphView,
  graph: SystemGraphSize,
  viewport: SystemGraphSize,
  visibleRects: readonly SystemGraphRect[] = [
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

export type SystemGraphArrowKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown";

export function panSystemGraphViewWithKeyboard(
  view: SystemGraphView,
  key: SystemGraphArrowKey,
): SystemGraphView {
  switch (key) {
    case "ArrowLeft":
      return { ...view, x: view.x - SYSTEM_GRAPH_KEYBOARD_PAN_STEP };
    case "ArrowRight":
      return { ...view, x: view.x + SYSTEM_GRAPH_KEYBOARD_PAN_STEP };
    case "ArrowUp":
      return { ...view, y: view.y - SYSTEM_GRAPH_KEYBOARD_PAN_STEP };
    case "ArrowDown":
      return { ...view, y: view.y + SYSTEM_GRAPH_KEYBOARD_PAN_STEP };
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

export function revealSystemGraphRect(
  view: SystemGraphView,
  graph: SystemGraphSize,
  viewport: SystemGraphSize,
  rect: SystemGraphRect,
): SystemGraphView {
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

export function zoomSystemGraphAtPointer(
  view: SystemGraphView,
  nextZoom: number,
  pointer: SystemGraphPoint,
): SystemGraphView {
  if (view.zoom <= 0 || nextZoom === view.zoom)
    return { ...view, zoom: nextZoom };
  const ratio = nextZoom / view.zoom;
  return {
    zoom: nextZoom,
    x: pointer.x - ratio * (pointer.x - view.x),
    y: pointer.y - ratio * (pointer.y - view.y),
  };
}

export interface SystemGraphPoint {
  x: number;
  y: number;
}

export function wheelSystemGraphView(
  view: SystemGraphView,
  deltaY: number,
  pointer: SystemGraphPoint,
  minZoom: number,
): SystemGraphView {
  const zoom = clampSystemGraphZoom(
    view.zoom * Math.exp(-deltaY * SYSTEM_GRAPH_WHEEL_RATE),
    minZoom,
  );
  return zoomSystemGraphAtPointer(view, zoom, pointer);
}

export function createSystemGraphViewportStore(): SystemGraphViewportStore {
  const saved = new Map<WorkspaceKey, SystemGraphView>();
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
