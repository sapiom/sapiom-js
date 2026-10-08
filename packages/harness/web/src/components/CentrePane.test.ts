import { describe, expect, it } from "vitest";

import type { ProjectMapEntry, ProjectMapState } from "../lib/use-project-map";
import { projectMapMode } from "./CentrePane";

/**
 * The project view draws the map pane when the map has an agent to click or
 * when its states need the pane's own recovery; otherwise the agents are
 * cards, so none is ever unreachable (flow-navigation.md 4.3.3).
 */
const ready = (agents: number): ProjectMapState => ({
  status: "ready",
  refreshing: false,
  value: {
    projectId: "p",
    displayName: "p",
    git: null,
    map: { agents: Array.from({ length: agents }, (_, i) => ({ slug: `a${i}` })) },
  } as never,
});
const entry = (state: ProjectMapState, mapRef: string | null = null): ProjectMapEntry => ({
  state,
  git: null,
  mapRef,
  setMapRef: () => {},
  refresh: () => {},
});

describe("projectMapMode", () => {
  it("draws the map once it has an agent", () => {
    expect(projectMapMode({ entry: entry(ready(2)), durable: true })).toEqual({ kind: "map" });
    expect(projectMapMode({ entry: entry(ready(1), "main"), durable: true })).toEqual({ kind: "map" });
  });

  it("draws the map for a ready map with agents even when not durable", () => {
    expect(projectMapMode({ entry: entry(ready(1)), durable: false })).toEqual({ kind: "map" });
  });

  it("lists the agents as cards when there is no durable project", () => {
    expect(projectMapMode({ entry: entry(ready(0)), durable: false })).toEqual({ kind: "cards" });
    expect(projectMapMode({ entry: entry({ status: "loading" }), durable: false })).toEqual({
      kind: "cards",
    });
  });

  it("keeps the map pane while loading and on a read error", () => {
    expect(projectMapMode({ entry: entry({ status: "loading" }), durable: true })).toEqual({
      kind: "map",
    });
    expect(
      projectMapMode({
        entry: entry({ status: "error", message: "boom", unavailable: false }),
        durable: true,
      }),
    ).toEqual({ kind: "map" });
    expect(
      projectMapMode({
        entry: entry({ status: "error", message: "gone", unavailable: true }),
        durable: true,
      }),
    ).toEqual({ kind: "map" });
  });

  it("lists cards for an empty working copy", () => {
    expect(projectMapMode({ entry: entry(ready(0)), durable: true })).toEqual({ kind: "cards" });
  });

  it("keeps the map pane for an empty git ref so the ref selector stays reachable", () => {
    expect(projectMapMode({ entry: entry(ready(0), "feature/x"), durable: true })).toEqual({
      kind: "map",
    });
  });
});
