import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";

interface WorkflowActionsHeaderProps {
  workflow: WorkflowInfo;
  onReVisualize: () => void;
  reVisualizeDisabledReason: string | null;
}

/**
 * Slim identity strip above the canvas pane, shown whenever a workflow is
 * bound to the active session — name, deployed status, and a re-visualize
 * affordance. Since Visualize itself moved to the docked action strip, this
 * button IS that action for the pane you're already looking at: one click
 * re-fires the same one-click macro; the pane swaps in the new render once
 * the agent's canvas.reload event arrives (see CanvasPane).
 */
export function WorkflowActionsHeader({
  workflow,
  onReVisualize,
  reVisualizeDisabledReason,
}: WorkflowActionsHeaderProps): JSX.Element {
  return (
    <div className="workflow-actions-header" data-testid="workflow-actions-header">
      <span className="workflow-actions-name">{workflow.name}</span>
      {workflow.definitionId != null && (
        <span className="workflow-dot workflow-dot-pinned" data-tooltip="Deployed to production" />
      )}
      <button
        className="macro-icon-btn canvas-refresh-btn"
        aria-label="Re-visualize"
        data-testid="canvas-revisualize"
        data-tooltip={reVisualizeDisabledReason ?? "Re-visualize"}
        disabled={Boolean(reVisualizeDisabledReason)}
        onClick={onReVisualize}
      >
        <Icon name="RefreshCw" size={14} />
      </button>
    </div>
  );
}
