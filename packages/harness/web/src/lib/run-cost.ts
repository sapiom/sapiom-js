/**
 * Run-cost arithmetic shared by every surface that shows money (steps list,
 * run chip, wallet). One implementation so the app can never disagree with
 * itself about what a run cost — and so the honesty rule (absent, never a
 * fabricated $0.00) is enforced in one place.
 */
import type { RunView } from "@shared/types";

import type { ObservedRun, RunTarget } from "./use-harness-state";

/**
 * The ONE money formatter: whole-cent amounts render as $X.XX; anything
 * with sub-cent residue keeps four decimals, so a displayed total always
 * equals the sum of its displayed parts ($0.0030 + $0.0125 must read
 * $0.0155, never a rounded $0.01 + $0.0030 next to a $0.0155 total).
 */
export function formatCostExact(usd: number): string {
  const cents = Math.round(usd * 1e6) / 1e4;
  return Number.isInteger(cents) ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * A run's total cost = the sum of its steps' captured USD. Null when NO step
 * carried a cost (a run of free/stubbed steps has no number to show).
 * Settled at micro-dollar precision: float sums drift in binary
 * (0.003 + 0.0125 !== 0.0155) and a displayed total must match the sum of
 * the displayed parts exactly.
 */
export function runCostUsd(run: RunView): number | null {
  let total = 0;
  let billedSteps = 0;
  for (const step of run.steps) {
    if (step.costUsd !== undefined) {
      total += step.costUsd;
      billedSteps += 1;
    }
  }
  return billedSteps > 0 ? Math.round(total * 1e6) / 1e6 : null;
}

/**
 * The run's money truth in one phrase. Captured cost data always wins —
 * if any step recorded USD, that sum IS the label, whatever the target
 * claimed. With no captured cost, the target decides: local runs are
 * stubbed and free by contract, prod runs are billed even before their
 * cost lands (never a fabricated $0.00). Null when the target is unknown
 * AND no cost was captured — nothing honest to say.
 */
export function runCostLabel(run: RunView, target: RunTarget | null): string | null {
  const cost = runCostUsd(run);
  if (cost !== null) return formatCostExact(cost);
  if (target === "local") return "free";
  return target === "prod" ? "billed" : null;
}

/** "local run · free" / "prod run · $0.0155" — the steps header's summary. */
export function runSummaryLabel(run: RunView, target: RunTarget | null): string {
  const kind = target ? `${target} run` : "run";
  const cost = runCostLabel(run, target);
  return cost ? `${kind} · ${cost}` : kind;
}

/**
 * Observed cost aggregates for ONE workflow, computed over the runs whose
 * session was bound to it when they started (ObservedRun.workflowPath —
 * attribution is captured at announcement time, never re-derived from the
 * current binding). This is the honest input for the subheader's price slot:
 * "typically ~$X per run" is an observed average, not a rate card.
 */
export interface WorkflowCostStats {
  /** Every run attributed to the workflow, costed or not. */
  observedRuns: number;
  /** Runs that captured at least one step cost — the average's denominator.
   *  Free local runs and not-yet-billed prod runs never dilute the price. */
  costedRuns: number;
  /** Micro-dollar-settled sum across the costed runs. */
  totalUsd: number;
  /** totalUsd / costedRuns, micro-dollar settled; null when nothing priced
   *  this workflow yet (absence, never a fabricated $0.00 average). */
  averageUsd: number | null;
}

export function workflowCostStats(runs: Iterable<ObservedRun>, workflowPath: string): WorkflowCostStats {
  let observedRuns = 0;
  let costedRuns = 0;
  let totalUsd = 0;
  for (const observed of runs) {
    if (observed.workflowPath !== workflowPath) continue;
    observedRuns += 1;
    const cost = runCostUsd(observed.run);
    if (cost === null) continue;
    costedRuns += 1;
    totalUsd += cost;
  }
  totalUsd = Math.round(totalUsd * 1e6) / 1e6;
  const averageUsd = costedRuns > 0 ? Math.round((totalUsd / costedRuns) * 1e6) / 1e6 : null;
  return { observedRuns, costedRuns, totalUsd, averageUsd };
}
