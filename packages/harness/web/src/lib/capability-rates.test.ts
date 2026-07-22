import { describe, expect, it } from "vitest";

import type { CanvasGraph, CanvasGraphNode } from "./canvas-graph";
import { CAPABILITY_RATES_USD, estimateRunCost } from "./capability-rates";

const node = (
  id: string,
  kind: CanvasGraphNode["kind"],
  capabilities: string[] = [],
): CanvasGraphNode => ({
  id,
  kind,
  label: id,
  role: "",
  description: "",
  timeoutMs: null,
  inputSchema: null,
  capabilities,
});

/** Same micro-dollar settling the module applies (raw float sums drift). */
const settle = (usd: number): number => Math.round(usd * 1e6) / 1e6;

const graph = (nodes: CanvasGraphNode[], edges: [string, string][], entry = nodes[0]?.id ?? ""): CanvasGraph => ({
  name: "t",
  entry,
  nodes,
  edges: edges.map(([from, to]) => ({ from, to, kind: "sequential", label: "" })),
  groups: [],
  warnings: [],
});

describe("estimateRunCost", () => {
  it("returns null when no step declares a listed-rate capability", () => {
    const g = graph([node("a", "entry"), node("b", "terminal-success")], [["a", "b"]]);
    expect(estimateRunCost(g)).toBeNull();
    const unlistedOnly = graph(
      [node("a", "entry", ["not.listed"]), node("b", "terminal-success")],
      [["a", "b"]],
    );
    expect(estimateRunCost(unlistedOnly)).toBeNull();
  });

  it("a linear pipeline estimates one figure: low equals high", () => {
    const g = graph(
      [node("a", "entry", ["records.read"]), node("b", "step", ["credit.check"]), node("c", "terminal-success")],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const est = estimateRunCost(g);
    expect(est).not.toBeNull();
    const expected = settle(CAPABILITY_RATES_USD["records.read"] + CAPABILITY_RATES_USD["credit.check"]);
    expect(est?.lowUsd).toBe(expected);
    expect(est?.highUsd).toBe(expected);
    expect(est?.meteredSteps).toBe(2);
    expect(est?.unlistedCapabilities).toEqual([]);
  });

  it("a branch spreads the range: cheapest exit path to every step once", () => {
    // entry(read) -> branch: cheap terminal(write) | expensive step(check) -> terminal(write)
    const g = graph(
      [
        node("entry", "entry", ["records.read"]),
        node("cheap", "terminal-success", ["records.write"]),
        node("pricey", "step", ["credit.check"]),
        node("end", "terminal-warn", ["records.write"]),
      ],
      [
        ["entry", "cheap"],
        ["entry", "pricey"],
        ["pricey", "end"],
      ],
    );
    const est = estimateRunCost(g);
    expect(est?.lowUsd).toBe(settle(CAPABILITY_RATES_USD["records.read"] + CAPABILITY_RATES_USD["records.write"]));
    expect(est?.highUsd).toBe(
      settle(
        CAPABILITY_RATES_USD["records.read"] +
          2 * CAPABILITY_RATES_USD["records.write"] +
          CAPABILITY_RATES_USD["credit.check"],
      ),
    );
  });

  it("unlisted capabilities are excluded from the sums and reported by id", () => {
    const g = graph(
      [node("a", "entry", ["records.read", "totally.unknown"]), node("b", "terminal-success")],
      [["a", "b"]],
    );
    const est = estimateRunCost(g);
    expect(est?.lowUsd).toBe(CAPABILITY_RATES_USD["records.read"]);
    expect(est?.highUsd).toBe(CAPABILITY_RATES_USD["records.read"]);
    expect(est?.unlistedCapabilities).toEqual(["totally.unknown"]);
  });

  it("a cycle with no reachable terminal falls back to the full traversal", () => {
    const g = graph(
      [node("a", "entry", ["records.read"]), node("b", "step", ["records.read"])],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    const est = estimateRunCost(g);
    expect(est?.lowUsd).toBe(est?.highUsd);
    expect(est?.highUsd).toBe(settle(2 * CAPABILITY_RATES_USD["records.read"]));
  });
});
