/**
 * Capability rate card + whole-run estimate: the upfront half of the price
 * ladder. Before any priced run exists, the steps subheader's price
 * slot shows a range estimated from the LISTED per-call rates of the
 * capabilities the posted graph declares — always labeled as an estimate
 * with its basis, and replaced by the observed average the moment a real
 * run carries cost (WorkflowPriceNote already prefers observed truth).
 *
 * WHY a pin and not a fetch: server-side per-call price endpoints are still
 * unverified, so this module pins list rates for the
 * capability ids the Studio's fixtures and templates declare, the same
 * swap-point pattern lib/templates.ts uses — when a served rate card ships,
 * a fetch of the same shape replaces these constants without touching any
 * surface. Capabilities NOT listed here are never guessed at: they are
 * excluded from the sums and the popover says so.
 *
 * The range is structural, not statistical: the low end is the cheapest
 * entry-to-terminal path through the graph's real edges; the high end is
 * every step running once. Real runs land wherever the branch conditions
 * take them.
 */
import type { CanvasGraph, CanvasGraphNode } from "./canvas-graph";

/** Listed per-call USD rates by dotted capability id. */
export const CAPABILITY_RATES_USD: Record<string, number> = {
  "records.read": 0.001,
  "records.write": 0.001,
  "credit.check": 0.0125,
  "rules.evaluate": 0.0005,
  "web.search": 0.004,
};

export interface RunCostEstimate {
  /** Cheapest entry-to-terminal path by listed rates, micro-dollar settled. */
  lowUsd: number;
  /** Every step running once, micro-dollar settled. */
  highUsd: number;
  /** Steps carrying at least one listed-rate capability. */
  meteredSteps: number;
  /** Declared capability ids with no listed rate — excluded from the sums. */
  unlistedCapabilities: string[];
}

const settle = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/** A node's listed-rate sum (unlisted capabilities contribute nothing). */
function nodeRateUsd(node: CanvasGraphNode): number {
  return node.capabilities.reduce((sum, cap) => sum + (CAPABILITY_RATES_USD[cap] ?? 0), 0);
}

/**
 * Estimate a run's cost range from the posted graph. Null when no step
 * declares a capability with a listed rate — nothing honest to estimate,
 * so the price slot keeps its quiet pre-run state instead.
 */
export function estimateRunCost(graph: CanvasGraph): RunCostEstimate | null {
  const rateById = new Map(graph.nodes.map((n) => [n.id, nodeRateUsd(n)]));
  const meteredSteps = graph.nodes.filter((n) => nodeRateUsd(n) > 0).length;
  if (meteredSteps === 0) return null;

  const unlisted = new Set<string>();
  for (const node of graph.nodes) {
    for (const cap of node.capabilities) {
      if (!(cap in CAPABILITY_RATES_USD)) unlisted.add(cap);
    }
  }

  const highUsd = settle(graph.nodes.reduce((sum, n) => sum + nodeRateUsd(n), 0));

  // Cheapest entry-to-terminal path (DFS with memo; cycles read as dead
  // ends). A terminal is a terminal-kind node or one with no outgoing edge.
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const isTerminal = (node: CanvasGraphNode): boolean =>
    node.kind === "terminal-success" ||
    node.kind === "terminal-warn" ||
    (outgoing.get(node.id) ?? []).length === 0;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const cheapestFrom = (id: string): number => {
    const node = nodeById.get(id);
    if (!node) return Number.POSITIVE_INFINITY;
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return Number.POSITIVE_INFINITY;
    visiting.add(id);
    const own = rateById.get(id) ?? 0;
    let result: number;
    if (isTerminal(node)) {
      result = own;
    } else {
      let best = Number.POSITIVE_INFINITY;
      for (const next of outgoing.get(id) ?? []) best = Math.min(best, cheapestFrom(next));
      result = own + best;
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  const entryId = nodeById.has(graph.entry) ? graph.entry : graph.nodes[0]?.id;
  const cheapest = entryId != null ? cheapestFrom(entryId) : Number.POSITIVE_INFINITY;
  // No terminal reachable from the entry (malformed or cyclic graph): the
  // only honest floor left is the full traversal.
  const lowUsd = Number.isFinite(cheapest) ? settle(Math.min(cheapest, highUsd)) : highUsd;

  return { lowUsd, highUsd, meteredSteps, unlistedCapabilities: [...unlisted].sort() };
}
