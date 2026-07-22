import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";

import type { RunCostEstimate } from "../lib/capability-rates";
import { formatCostExact, type WorkflowCostStats } from "../lib/run-cost";
import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";

/** Counts read as words with their noun, never a bare digit. */
function runsWord(count: number): string {
  return count === 1 ? "1 run" : `${count} runs`;
}

/** "est. $0.0160 to $0.0170 per run", collapsing an equal range to one figure. */
function estimateLabel(estimate: RunCostEstimate): string {
  if (estimate.lowUsd === estimate.highUsd) return `est. ${formatCostExact(estimate.highUsd)} per run`;
  return `est. ${formatCostExact(estimate.lowUsd)} to ${formatCostExact(estimate.highUsd)} per run`;
}

interface WorkflowPriceNoteProps {
  /** Observed cost aggregates for the presented workflow (lib/run-cost). */
  stats: WorkflowCostStats;
  /** Rate-card estimate from the posted graph (lib/capability-rates) — the
   *  pre-run rung of the price ladder. Null when no graph has been posted
   *  or nothing in it carries a listed rate. */
  estimate: RunCostEstimate | null;
}

/**
 * The steps subheader's upfront-price slot for the presented workflow, a
 * three-state ladder that never guesses silently:
 * 1. Observed runs carry cost — the observed average, with its basis (run
 *    count, observed total) in the popover. Observed truth always wins.
 * 2. No priced run yet, but the posted graph declares listed-rate
 *    capabilities — a range CLEARLY LABELED as an estimate ("est. …"),
 *    with the popover naming the basis: listed capability rates, cheapest
 *    path to every-step-once, and that real runs replace it.
 * 3. Neither — a quiet "Priced after the first run".
 * The chip is the glance; the popover carries the basis. Narrow panes
 * degrade the chip to icon-only (CSS container query) — the aria-label,
 * tooltip, and popover keep the words.
 */
export function WorkflowPriceNote({ stats, estimate }: WorkflowPriceNoteProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // formatCostExact, not formatCost: the average must agree with the total
  // line below it ($0.0155 avg over 1 run cannot read "~$0.02 per run").
  const average = stats.averageUsd;
  const priced = average !== null;
  const chipLabel =
    average !== null
      ? `~${formatCostExact(average)} per run`
      : estimate !== null
        ? estimateLabel(estimate)
        : "Priced after the first run";

  return (
    <div className="workflow-price-wrap">
      <button
        ref={triggerRef}
        className={"status-tag status-tag-action workflow-price-note" + (priced ? " is-priced" : "")}
        data-testid="workflow-price-note"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={chipLabel}
        data-tooltip={priced ? "Observed price for this agent" : "How this agent gets priced"}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="Coins" size={12} />
        <span className="workflow-price-label">{chipLabel}</span>
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={close}
        placement="down-end"
        className="workflow-price-popover"
        role="dialog"
        testid="workflow-price-popover"
      >
        {average !== null ? (
          <>
            <p className="workflow-price-lead">
              {`Typically ~${formatCostExact(average)} per run, observed over ${runsWord(stats.costedRuns)}.`}
            </p>
            <p className="workflow-price-line" data-testid="workflow-price-total">
              {`${formatCostExact(stats.totalUsd)} total across ${runsWord(stats.costedRuns)} this Studio session.`}
            </p>
            <p className="workflow-price-hint">
              Observed from real runs, not a rate card. Runs before this page load are not counted.
            </p>
          </>
        ) : estimate !== null ? (
          <>
            <p className="workflow-price-lead">
              {estimate.lowUsd === estimate.highUsd
                ? `Estimated ${formatCostExact(estimate.highUsd)} per run from listed capability rates.`
                : `Estimated ${formatCostExact(estimate.lowUsd)} to ${formatCostExact(estimate.highUsd)} per run from listed capability rates.`}
            </p>
            {/* No node count here: the subheader already states the step
                count on the shared rule, and a second count risks reading
                as a contradiction. */}
            <p className="workflow-price-line" data-testid="workflow-price-basis">
              The range spans the cheapest exit path to every step running once.
            </p>
            {estimate.unlistedCapabilities.length > 0 && (
              <p className="workflow-price-line" data-testid="workflow-price-unlisted">
                {`Not counted (no listed rate): ${estimate.unlistedCapabilities.join(", ")}.`}
              </p>
            )}
            <p className="workflow-price-hint">
              An estimate, not a bill: real runs replace it here. Local test runs are free.
            </p>
          </>
        ) : (
          <>
            <p className="workflow-price-lead">No priced runs observed this Studio session.</p>
            <p className="workflow-price-hint">
              {stats.observedRuns > 0
                ? `${runsWord(stats.observedRuns)} observed, none carried a cost. Local runs are free; prices come from billed runs.`
                : "Run this agent once and its observed price appears here."}
            </p>
          </>
        )}
      </AnchoredPopover>
    </div>
  );
}
