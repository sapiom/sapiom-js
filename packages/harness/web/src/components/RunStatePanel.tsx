/**
 * Presentational live-run panel.
 *
 * Consumes a transport-agnostic RunView — the same shape regardless of whether
 * state arrives via HTTP polling (today) or a future WebSocket push. No fetching
 * happens here: this component renders whatever the caller provides.
 */
import type { JSX } from "react";
import type { RunView, StepView } from "@shared/types";

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function runStatusLabel(status: RunView["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function StepRow({ step }: { step: StepView }): JSX.Element {
  return (
    <li className="run-step" data-status={step.status} data-testid="run-step">
      <span className="run-step-dot" data-status={step.status} aria-hidden />
      <span className="run-step-name">{step.name}</span>
      {step.latencyMs != null && (
        <span className="run-step-latency">
          {formatLatency(step.latencyMs)}
        </span>
      )}
      {step.status === "failed" && step.error && (
        <p className="run-step-error">{step.error}</p>
      )}
    </li>
  );
}

export function RunStatePanel({ runView }: { runView: RunView }): JSX.Element {
  const passedCount = runView.steps.filter((s) => s.status === "passed").length;

  return (
    // A plain div (not a <section>) to match the sibling content blocks in
    // CanvasPane and avoid an unlabeled landmark region for screen readers.
    <div className="run-state-panel" data-testid="run-state-panel">
      <div className="run-state-header">
        <span
          className="run-state-status"
          data-status={runView.status}
          data-testid="run-state-status"
        >
          {runStatusLabel(runView.status)}
        </span>
        <span className="run-state-count">
          {passedCount}/{runView.steps.length}
        </span>
      </div>
      <ol className="run-steps">
        {runView.steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ol>
    </div>
  );
}
