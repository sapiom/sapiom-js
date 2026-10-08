import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { track as trackProduct } from "../lib/analytics/events";
import { relativeTimeLabel } from "../lib/relative-time";
import type { ObservedRun } from "../lib/use-harness-state";
import { EmptyState } from "./EmptyState";
import { RunWorkspace } from "./RunWorkspace";

/** Row chip copy: "local run completed (stubbed)". The same words the board's
 *  run chip uses, plus the stub mark a local run carries. */
function runRowLabel(observed: ObservedRun): string {
  const { run, target } = observed;
  return `${target} run ${run.status}${run.stubbed ? " (stubbed)" : ""}`;
}

/**
 * The agent modal's Runs tab (flow-map-chat-overlay.md 4.7.1; mock
 * `RunsPanel.tsx`): the run workspace the old right pane carried, so a run
 * has a home. The agent's runs newest first on the left; the shown run's
 * workspace on the right (timeline, result, and the attempt inspector for a
 * picked attempt). Runs are the store's, keyed by agent path (I3); picking a
 * row is `selectRun`, the same pick the board's run chip makes.
 *
 * Focus mode stays off here: the modal already gives the workspace most of
 * the screen, and 4.7.1 names list, timeline, artifacts and attempts only.
 */
export function RunsPanel({
  agent,
  runs,
  shown,
  onSelectRun,
  onAskAgent,
}: {
  agent: WorkflowInfo;
  /** Every run of this agent, oldest first. */
  runs: ObservedRun[];
  /** The run the modal shows: the picked one, else the latest. */
  shown: ObservedRun | null;
  onSelectRun: (executionId: string) => void;
  /** The attempt inspector's Ask: a new session about this agent (4.4b). */
  onAskAgent: (prompt: string) => void;
}): JSX.Element {
  if (runs.length === 0 || !shown) {
    return (
      <EmptyState
        className="canvas-empty"
        testId="runs-empty"
        icon="Play"
        title="No runs yet"
        body="Run it locally or on Sapiom from the header; its runs land here."
      />
    );
  }

  const target = shown.target;
  return (
    <div className="runs-panel" data-testid="runs-panel">
      <ul className="runs-list" data-testid="runs-list" aria-label="Runs">
        {[...runs].reverse().map((observed) => {
          const picked = observed.run.executionId === shown.run.executionId;
          return (
            <li key={observed.run.executionId}>
              <button
                type="button"
                className={"runs-list-row" + (picked ? " is-selected" : "")}
                data-testid={`runs-row-${observed.run.executionId}`}
                aria-current={picked ? "true" : undefined}
                onClick={() => onSelectRun(observed.run.executionId)}
              >
                <span
                  className={"status-tag canvas-run-chip is-" + observed.run.status}
                >
                  {observed.run.status === "running" && (
                    <span className="canvas-run-status is-running" aria-hidden="true" />
                  )}
                  {runRowLabel(observed)}
                </span>
                <span className="runs-list-sub">
                  <span>{relativeTimeLabel(observed.observedAt)}</span>
                  <code title={observed.run.executionId}>
                    {observed.run.executionId}
                  </code>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="runs-detail">
        <RunWorkspace
          run={shown.run}
          target={target}
          workflow={agent}
          focus={false}
          onToggleFocus={() => {}}
          onAskAgent={onAskAgent}
          onInspectionOpened={() =>
            trackProduct("run.inspection_opened", { target })
          }
          onArtifactViewed={() => trackProduct("run.artifact_viewed", { target })}
          onDashboardOpened={() =>
            trackProduct("run.dashboard_opened", { target })
          }
        />
      </div>
    </div>
  );
}
