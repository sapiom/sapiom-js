import { describe, expect, it } from "vitest";
import type { RunView } from "@shared/types";

import { formatCostExact, runCostLabel, runCostUsd, workflowCostStats } from "./run-cost";
import type { ObservedRun, RunTarget } from "./use-harness-state";

/** A RunView whose steps carry the given costs (undefined = honest absence). */
function runWith(executionId: string, costs: (number | undefined)[]): RunView {
  return {
    executionId,
    status: "completed",
    steps: costs.map((costUsd, index) => ({
      id: `s${index}`,
      name: `s${index}`,
      status: "passed" as const,
      ...(costUsd !== undefined ? { costUsd } : {}),
    })),
  };
}

function observed(
  executionId: string,
  costs: (number | undefined)[],
  workflowPath: string | null,
  target: RunTarget = "prod",
): ObservedRun {
  return { run: runWith(executionId, costs), target, workflowPath, observedAt: 0 };
}

describe("runCostUsd", () => {
  it("sums captured step costs at micro-dollar precision (no float drift)", () => {
    // 0.003 + 0.0125 !== 0.0155 in binary; the settled sum must equal it.
    expect(runCostUsd(runWith("e", [0.003, 0.0125, undefined]))).toBe(0.0155);
  });

  it("is null when NO step carried a cost (absence, never $0.00)", () => {
    expect(runCostUsd(runWith("e", [undefined, undefined]))).toBeNull();
  });
});

describe("runCostLabel", () => {
  it("captured cost wins whatever the target claimed", () => {
    expect(runCostLabel(runWith("e", [0.0155]), "local")).toBe("$0.0155");
  });

  it("without captured cost, local reads free and prod reads billed", () => {
    expect(runCostLabel(runWith("e", [undefined]), "local")).toBe("free");
    expect(runCostLabel(runWith("e", [undefined]), "prod")).toBe("billed");
    expect(runCostLabel(runWith("e", [undefined]), null)).toBeNull();
  });
});

describe("workflowCostStats", () => {
  it("attributes runs by the workflowPath captured at start, nothing else", () => {
    const runs = [
      observed("a", [0.003, 0.0125], "/ws/leasing"),
      observed("b", [0.0155], "/ws/rfq"),
      observed("c", [0.01], null), // ran while nothing was bound: attributed nowhere
    ];
    const stats = workflowCostStats(runs, "/ws/leasing");
    expect(stats.observedRuns).toBe(1);
    expect(stats.costedRuns).toBe(1);
    expect(stats.totalUsd).toBe(0.0155);
    expect(stats.averageUsd).toBe(0.0155);
  });

  it("costless runs count as observed but never dilute the average", () => {
    const runs = [
      observed("a", [0.0155], "/ws/leasing"),
      observed("b", [undefined], "/ws/leasing", "local"), // free local run
      observed("c", [undefined], "/ws/leasing"), // prod run whose cost has not landed
    ];
    const stats = workflowCostStats(runs, "/ws/leasing");
    expect(stats.observedRuns).toBe(3);
    expect(stats.costedRuns).toBe(1);
    expect(stats.averageUsd).toBe(0.0155);
  });

  it("no attributed runs at all: average is null, never a fabricated $0.00", () => {
    const stats = workflowCostStats([], "/ws/leasing");
    expect(stats).toEqual({ observedRuns: 0, costedRuns: 0, totalUsd: 0, averageUsd: null });
  });

  it("settles the multi-run total and average at micro-dollar precision", () => {
    const runs = [
      observed("a", [0.003, 0.0125], "/ws/leasing"),
      observed("b", [0.003, 0.0125], "/ws/leasing"),
    ];
    const stats = workflowCostStats(runs, "/ws/leasing");
    expect(stats.totalUsd).toBe(0.031);
    expect(stats.averageUsd).toBe(0.0155);
  });
});

describe("formatCostExact", () => {
  it("keeps sub-cent residue at four decimals and whole cents at two", () => {
    expect(formatCostExact(0.0155)).toBe("$0.0155");
    expect(formatCostExact(0.02)).toBe("$0.02");
  });
});
