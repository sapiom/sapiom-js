import type { JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { MacroButtons } from "./MacroButtons";

interface WorkflowActionsHeaderProps {
  workflow: WorkflowInfo;
  activeSessionId: string | null;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef, subject?: string) => void;
}

/**
 * Slim strip above the canvas pane, shown whenever a workflow is bound to the
 * active session — the full macro set (including Visualize, which stays
 * scoped to whatever's actually bound) lives here now that the standalone
 * action rail is gone.
 */
export function WorkflowActionsHeader({
  workflow,
  activeSessionId,
  macros,
  onRunMacro,
}: WorkflowActionsHeaderProps): JSX.Element {
  return (
    <div className="workflow-actions-header" data-testid="workflow-actions-header">
      <span className="workflow-actions-name">{workflow.name}</span>
      {workflow.definitionId != null && <span className="workflow-dot" title="Deployed" />}
      <div className="workflow-actions-buttons">
        <MacroButtons macros={macros} workflow={workflow} activeSessionId={activeSessionId} onRun={onRunMacro} size={15} />
      </div>
    </div>
  );
}
