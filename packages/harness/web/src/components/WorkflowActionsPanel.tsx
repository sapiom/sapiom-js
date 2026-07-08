import type { JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { macroDisabledReason } from "../lib/macro-gating";
import { Icon } from "./Icon";

interface WorkflowActionsPanelProps {
  workflow: WorkflowInfo | null;
  activeSessionId: string | null;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef) => void;
}

/**
 * Persistent action panel docked between the workspace rail and the
 * terminal — its own fixed-width grid column (see .app in styles.css), not
 * a floating overlay, so it can never sit on top of (or bleed into) the
 * terminal. Icon + label are always visible, stacked vertically; a gated
 * action's disabled reason renders inline as a caption rather than only
 * appearing on hover, since nothing here is hover-revealed anymore.
 *
 * The macro list itself always renders regardless of `workflow` — Visualize
 * and AI Visualize both run the deterministic/LLM render unbound (workspace
 * overview) as well as bound, so gating is entirely per-macro via
 * macroDisabledReason (requiresWorkflow: true macros show "Select a
 * workflow first" when `workflow` is null; the render macros don't).
 */
export function WorkflowActionsPanel({
  workflow,
  activeSessionId,
  macros,
  onRunMacro,
}: WorkflowActionsPanelProps): JSX.Element {
  return (
    <div className="action-panel" data-testid="workflow-actions-panel">
      <div className="action-panel-header">
        Actions
        {workflow && <span className="action-panel-header-workflow"> · {workflow.name}</span>}
      </div>
      {macros.map((macro) => {
        const disabledReason = macroDisabledReason(macro, workflow, activeSessionId);
        return (
          <button
            key={macro.id}
            className="action-panel-item"
            data-testid={`macro-${macro.id}`}
            aria-label={disabledReason ? `${macro.label}: ${disabledReason}` : macro.label}
            disabled={Boolean(disabledReason)}
            onClick={() => onRunMacro(macro)}
          >
            <span className="action-panel-item-icon">
              <Icon name={macro.icon} size={15} />
            </span>
            <span className="action-panel-item-text">
              <span className="action-panel-item-label">{macro.label}</span>
              {disabledReason && <span className="action-panel-item-reason">{disabledReason}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
