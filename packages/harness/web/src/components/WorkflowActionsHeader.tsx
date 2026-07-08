import type { JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";
import { MacroButtons } from "./MacroButtons";

interface WorkflowActionsHeaderProps {
  workflow: WorkflowInfo;
  activeSessionId: string | null;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef) => void;
  onRefresh: () => void;
}

/**
 * The canvas pane's entire header, shown whenever a workflow is bound to the
 * active session: the full macro set (including Visualize, which stays
 * scoped to whatever's actually bound) now that the standalone action rail
 * is gone, plus a manual refresh affordance for the canvas itself.
 */
export function WorkflowActionsHeader({
  workflow,
  activeSessionId,
  macros,
  onRunMacro,
  onRefresh,
}: WorkflowActionsHeaderProps): JSX.Element {
  return (
    <div className="workflow-actions-header" data-testid="workflow-actions-header">
      <span className="workflow-actions-name">{workflow.name}</span>
      {workflow.definitionId != null && <span className="workflow-dot" title="Deployed" />}
      <div className="workflow-actions-buttons">
        <MacroButtons macros={macros} workflow={workflow} activeSessionId={activeSessionId} onRun={onRunMacro} size={15} />
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
    </div>
  );
}
