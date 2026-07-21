/**
 * Step-detail panel — opens when a canvas node is clicked during a live run.
 * Shows the step's status, latency, error, and log slice, plus debug macros
 * that inject the step's log context into the active session alongside a
 * pre-formed question. Also exposes a free-form textarea for custom asks.
 *
 * The panel is rendered as an overlay inside the canvas pane. It is dismissable
 * via the close button or the Escape key.
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { RunCall, RunStepSpend, StepView } from "@shared/types";
import {
  extractStepContext,
  extractStepLinks,
  formatLatency,
} from "../lib/extract-step-context";
import { formatUsd } from "../lib/format-usd";

interface StepDetailPanelProps {
  step: StepView;
  /** Per-step spend data from the spend endpoint, if available. */
  spend?: RunStepSpend;
  /** Per-call cost drill-down for this step (the "why costly" breakdown). */
  calls?: RunCall[];
  onClose: () => void;
  onInject: (text: string, submit: boolean) => void;
}

/** Map a step status to a display label and a CSS modifier. */
function statusChip(status: StepView["status"]): {
  label: string;
  modifier: string;
} {
  switch (status) {
    case "running":
      return { label: "running", modifier: "step-detail-chip--running" };
    case "passed":
      return { label: "passed", modifier: "step-detail-chip--passed" };
    case "failed":
      return { label: "failed", modifier: "step-detail-chip--failed" };
    default:
      return { label: "pending", modifier: "step-detail-chip--pending" };
  }
}

export function StepDetailPanel({
  step,
  spend,
  calls,
  onClose,
  onInject,
}: StepDetailPanelProps): JSX.Element {
  const [freeformText, setFreeformText] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const chip = statusChip(step.status);
  // Any URLs the step surfaced in its logs (preview/deploy URL, download link).
  const links = extractStepLinks(step);

  // Dismiss on Escape.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function inject(question: string): void {
    const ctx = extractStepContext(step, spend, calls);
    onInject(`${ctx}\n\n${question}`, true);
  }

  function handleFreeformAsk(): void {
    if (!freeformText.trim()) return;
    inject(freeformText.trim());
    setFreeformText("");
  }

  return (
    <div
      className="step-detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Step detail: ${step.name}`}
      data-testid="step-detail-panel"
      ref={panelRef}
    >
      {/* Header */}
      <div className="step-detail-header">
        <span className="step-detail-name">{step.name}</span>
        <span className={`step-detail-chip ${chip.modifier}`}>
          {chip.label}
        </span>
        {step.latencyMs != null && (
          <span className="step-detail-latency">
            {formatLatency(step.latencyMs)}
          </span>
        )}
        <button
          className="step-detail-close btn-ghost"
          data-testid="step-detail-close"
          aria-label="Close step detail"
          onClick={onClose}
        >
          &times;
        </button>
      </div>

      {/* Cost line (shown when spend data is available for this step) */}
      {spend != null ? (
        <div className="step-detail-cost" data-testid="step-detail-cost">
          Cost: {formatUsd(spend.totalUsd)} · {spend.entryCount}{" "}
          {spend.entryCount === 1 ? "call" : "calls"}
        </div>
      ) : null}

      {/* Per-call cost drill-down — "why is this costly". Provider-agnostic
          capability labels; token counts are not shown (not recorded by the
          platform for gateway LLM calls). */}
      {calls != null && calls.length > 0 && (
        <div
          className="step-detail-breakdown"
          data-testid="step-detail-breakdown"
        >
          <div className="step-detail-breakdown-title">Cost breakdown</div>
          <ul className="step-detail-breakdown-list">
            {calls.map((call, index) => (
              <li
                key={`${call.capability}-${call.op}-${index}`}
                className="step-detail-breakdown-row"
              >
                <span className="step-detail-breakdown-cap">
                  {call.capability}
                </span>
                <span className="step-detail-breakdown-op">{call.op}</span>
                <span className="step-detail-breakdown-usd">
                  {formatUsd(call.usd)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Error (failed steps only) */}
      {step.status === "failed" && step.error && (
        <div className="step-detail-error">{step.error}</div>
      )}

      {/* Links this step produced (e.g. a preview/deploy URL, a download link) */}
      {links.length > 0 && (
        <div className="step-detail-links" data-testid="step-detail-links">
          {links.map((url) => (
            <a
              key={url}
              className="step-detail-link"
              data-testid="step-detail-link"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {url}
            </a>
          ))}
        </div>
      )}

      {/* Log slice */}
      <div className="step-detail-logs-wrap">
        {step.logSlice ? (
          <pre className="step-detail-logs">{step.logSlice}</pre>
        ) : (
          <p className="step-detail-no-logs">No logs for this step.</p>
        )}
      </div>

      {/* Debug macros */}
      <div className="step-detail-macros">
        <button
          className="step-detail-macro-btn btn-ghost"
          data-testid="step-macro-slow"
          onClick={() => inject("Why is this step slow / stuck?")}
        >
          Why is this step slow / stuck?
        </button>
        <button
          className={`step-detail-macro-btn ${step.status === "failed" ? "btn-primary" : "btn-ghost"}`}
          data-testid="step-macro-debug"
          onClick={() => inject("Debug this step")}
        >
          Debug this step
        </button>
        <button
          className="step-detail-macro-btn btn-ghost"
          data-testid="step-macro-explain"
          onClick={() => inject("Explain this step")}
        >
          Explain this step
        </button>
      </div>

      {/* Free-form ask */}
      <div className="step-detail-freeform">
        <textarea
          className="step-detail-freeform-input"
          data-testid="step-freeform-input"
          placeholder="Ask about this step's logs…"
          rows={3}
          value={freeformText}
          onChange={(e) => setFreeformText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleFreeformAsk();
            }
          }}
        />
        <button
          className="btn-primary step-detail-freeform-ask"
          data-testid="step-freeform-ask"
          disabled={!freeformText.trim()}
          onClick={handleFreeformAsk}
        >
          Ask
        </button>
      </div>
    </div>
  );
}
