import type { WorkspaceKey } from "@shared/system-graph";

import {
  createGraphViewportStore,
  type GraphViewportStore,
} from "./graph-viewport";

/** Legacy names retained while SystemGraphCanvas coexists with Agent Map. */
export {
  GRAPH_DEFAULT_MIN_ZOOM as SYSTEM_GRAPH_DEFAULT_MIN_ZOOM,
  GRAPH_FLOOR_ZOOM as SYSTEM_GRAPH_FLOOR_ZOOM,
  GRAPH_KEYBOARD_PAN_STEP as SYSTEM_GRAPH_KEYBOARD_PAN_STEP,
  GRAPH_MAX_ZOOM as SYSTEM_GRAPH_MAX_ZOOM,
  GRAPH_WHEEL_RATE as SYSTEM_GRAPH_WHEEL_RATE,
  GRAPH_ZOOM_STEP as SYSTEM_GRAPH_ZOOM_STEP,
  clampGraphZoom as clampSystemGraphZoom,
  fitGraphView as fitSystemGraphView,
  graphViewIntersectsViewport as systemGraphViewIntersectsViewport,
  panGraphViewWithKeyboard as panSystemGraphViewWithKeyboard,
  resetGraphView as resetSystemGraphView,
  revealGraphRect as revealSystemGraphRect,
  wheelGraphView as wheelSystemGraphView,
  zoomGraphAtPointer as zoomSystemGraphAtPointer,
} from "./graph-viewport";
export type {
  GraphArrowKey as SystemGraphArrowKey,
  GraphFit as SystemGraphFit,
  GraphPoint as SystemGraphPoint,
  GraphRect as SystemGraphRect,
  GraphSize as SystemGraphSize,
  GraphView as SystemGraphView,
} from "./graph-viewport";

export type SystemGraphViewportStore = GraphViewportStore & {
  get(
    workspaceKey: WorkspaceKey,
  ): import("./graph-viewport").GraphView | undefined;
  set(
    workspaceKey: WorkspaceKey,
    view: import("./graph-viewport").GraphView,
  ): void;
};

export function createSystemGraphViewportStore(): SystemGraphViewportStore {
  return createGraphViewportStore() as SystemGraphViewportStore;
}
