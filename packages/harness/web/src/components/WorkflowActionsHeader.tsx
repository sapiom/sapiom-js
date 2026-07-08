import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";

interface WorkflowActionsHeaderProps {
  workflow: WorkflowInfo;
  onRefresh: () => void;
}

/**
 * Slim identity strip above the canvas pane, shown whenever a workflow is
 * bound to the active session — name, deployed status, and a manual refresh
 * affordance. The action buttons themselves live in the docked workflow
 * action strip now (WorkflowActionStrip, next to the workspace rail), not
 * duplicated here.
 */
export function WorkflowActionsHeader({ workflow, onRefresh }: WorkflowActionsHeaderProps): JSX.Element {
  return (
    <div className="workflow-actions-header" data-testid="workflow-actions-header">
      <span className="workflow-actions-name">{workflow.name}</span>
      {workflow.definitionId != null && <span className="workflow-dot" title="Deployed" />}
      <button
        className="macro-icon-btn canvas-refresh-btn"
        aria-label="Refresh canvas"
        data-testid="canvas-refresh"
        data-tooltip="Refresh canvas"
        onClick={onRefresh}
      >
        <Icon name="RefreshCw" size={14} />
      </button>
    </div>
  );
}
