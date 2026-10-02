import { describe, expect, it } from "vitest";

import { projectMapMode } from "./CentrePane";

/**
 * The project view draws the map pane only when the map has an agent to
 * click; otherwise its agents are cards, so none is ever unreachable
 * (flow-navigation.md 4.3.3).
 */
const ready = (kinds: string[]) => ({
  status: "ready" as const,
  value: { proposal: { nodes: kinds.map((kind, i) => ({ id: `n${i}`, kind })) } } as never,
});
const base = { unavailable: null, durable: true, initialization: null };

describe("projectMapMode", () => {
  it("draws the map once it has an agent node", () => {
    expect(projectMapMode({ ...base, state: ready(["resource", "agent"]) })).toEqual({ kind: "map" });
    expect(projectMapMode({ ...base, state: ready(["subagent"]) })).toEqual({ kind: "map" });
  });

  it("lists the agents as cards when the map draws no agent", () => {
    expect(projectMapMode({ ...base, state: ready(["resource", "service"]) })).toEqual({
      kind: "cards",
      map: "not-drawn",
    });
    expect(projectMapMode({ ...base, state: ready([]) })).toEqual({ kind: "cards", map: "not-drawn" });
  });

  it("keeps the map pane for storage states and shows generation over the cards", () => {
    expect(projectMapMode({ ...base, state: { status: "loading" } })).toEqual({ kind: "map" });
    expect(projectMapMode({ ...base, unavailable: "gone", state: ready([]) })).toEqual({ kind: "map" });
    expect(
      projectMapMode({ ...base, initialization: { status: "failed" }, state: ready([]) }),
    ).toEqual({ kind: "cards", map: "failed" });
    expect(projectMapMode({ ...base, durable: false, state: ready([]) })).toEqual({
      kind: "cards",
      map: "not-drawn",
    });
  });
});
