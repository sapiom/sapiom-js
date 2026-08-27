import { describe, expect, it } from "vitest";

import {
  SYSTEM_GRAPH_FLOOR_ZOOM,
  SYSTEM_GRAPH_KEYBOARD_PAN_STEP,
  SYSTEM_GRAPH_MAX_ZOOM,
  createSystemGraphViewportStore,
  fitSystemGraphView,
  panSystemGraphViewWithKeyboard,
  resetSystemGraphView,
  revealSystemGraphRect,
  systemGraphViewIntersectsViewport,
  zoomSystemGraphAtPointer,
} from "./system-graph-viewport";

describe("fitSystemGraphView", () => {
  it("contains a graph with preferred air in roomy, narrow, and short viewports", () => {
    for (const viewport of [
      { width: 1200, height: 800 },
      { width: 480, height: 800 },
      { width: 1200, height: 280 },
    ]) {
      const graph = { width: 900, height: 480 };
      const fit = fitSystemGraphView(graph, viewport, 16);
      const insetX = Math.min(3.5 * 16, viewport.width * 0.2);
      const insetY = Math.min(3.5 * 16, viewport.height * 0.2);
      expect(graph.width * fit.zoom).toBeLessThanOrEqual(
        viewport.width - insetX * 2 + 1,
      );
      expect(graph.height * fit.zoom).toBeLessThanOrEqual(
        viewport.height - insetY * 2 + 1,
      );
      expect(fit.x).toBe(0);
      expect(fit.y).toBe(0);
    }
  });

  it("uses the 10% hard floor only when a very large graph cannot fit above it", () => {
    const fit = fitSystemGraphView(
      { width: 20_000, height: 10_000 },
      { width: 600, height: 400 },
      16,
    );
    expect(fit.zoom).toBe(SYSTEM_GRAPH_FLOOR_ZOOM);
    expect(fit.minZoom).toBe(SYSTEM_GRAPH_FLOOR_ZOOM);
  });

  it("caps a tiny graph at the 300% maximum", () => {
    expect(
      fitSystemGraphView(
        { width: 20, height: 20 },
        { width: 1200, height: 800 },
        16,
      ).zoom,
    ).toBe(SYSTEM_GRAPH_MAX_ZOOM);
  });
});

describe("system graph view math", () => {
  it("resets to 100% with zero pan", () => {
    expect(resetSystemGraphView()).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("keeps the graph point beneath the pointer fixed while zooming", () => {
    const before = { zoom: 0.75, x: 28, y: -16 };
    const pointer = { x: 160, y: -90 };
    const graphPoint = {
      x: (pointer.x - before.x) / before.zoom,
      y: (pointer.y - before.y) / before.zoom,
    };
    const after = zoomSystemGraphAtPointer(before, 1.5, pointer);

    expect(after.x + graphPoint.x * after.zoom).toBeCloseTo(pointer.x, 8);
    expect(after.y + graphPoint.y * after.zoom).toBeCloseTo(pointer.y, 8);
  });

  it("rejects a restored view whose graph no longer intersects the viewport", () => {
    const graph = { width: 900, height: 480 };
    const viewport = { width: 600, height: 400 };

    expect(
      systemGraphViewIntersectsViewport(
        { zoom: 1, x: 0, y: 0 },
        graph,
        viewport,
      ),
    ).toBe(true);
    expect(
      systemGraphViewIntersectsViewport(
        { zoom: 1, x: 2_000, y: 2_000 },
        graph,
        viewport,
      ),
    ).toBe(false);
    expect(
      systemGraphViewIntersectsViewport(
        { zoom: 1, x: 749, y: 0 },
        graph,
        viewport,
      ),
    ).toBe(true);
    expect(
      systemGraphViewIntersectsViewport(
        { zoom: 1, x: 749, y: 0 },
        graph,
        viewport,
        [{ x: 32, y: 32, width: 184, height: 64 }],
      ),
    ).toBe(false);
  });

  it("pans by keyboard in the requested direction", () => {
    const view = { zoom: 1, x: 12, y: -8 };

    expect(panSystemGraphViewWithKeyboard(view, "ArrowLeft")).toEqual({
      ...view,
      x: view.x - SYSTEM_GRAPH_KEYBOARD_PAN_STEP,
    });
    expect(panSystemGraphViewWithKeyboard(view, "ArrowDown")).toEqual({
      ...view,
      y: view.y + SYSTEM_GRAPH_KEYBOARD_PAN_STEP,
    });
  });

  it("moves an offscreen focused card fully inside the viewport", () => {
    const graph = { width: 1_000, height: 600 };
    const viewport = { width: 500, height: 300 };
    const node = { x: 32, y: 32, width: 184, height: 64 };
    const hidden = { zoom: 1, x: -900, y: 0 };

    const revealed = revealSystemGraphRect(hidden, graph, viewport, node);
    const left =
      viewport.width / 2 +
      revealed.x +
      (node.x - graph.width / 2) * revealed.zoom;
    const top =
      viewport.height / 2 +
      revealed.y +
      (node.y - graph.height / 2) * revealed.zoom;

    expect(left).toBeGreaterThanOrEqual(16);
    expect(left + node.width * revealed.zoom).toBeLessThanOrEqual(
      viewport.width - 16,
    );
    expect(top).toBeGreaterThanOrEqual(16);
    expect(top + node.height * revealed.zoom).toBeLessThanOrEqual(
      viewport.height - 16,
    );
  });

  it("keeps in-memory views isolated per workspace", () => {
    const store = createSystemGraphViewportStore();
    store.set("workspace-a", { zoom: 1.5, x: 20, y: -10 });
    store.set("workspace-b", { zoom: 0.5, x: -30, y: 40 });

    expect(store.get("workspace-a")).toEqual({ zoom: 1.5, x: 20, y: -10 });
    expect(store.get("workspace-b")).toEqual({ zoom: 0.5, x: -30, y: 40 });
    expect(store.get("workspace-c")).toBeUndefined();
  });
});
