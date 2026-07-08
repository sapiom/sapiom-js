import type { CSSProperties, JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { MacroButtons } from "./MacroButtons";

interface WorkflowActionStripProps {
  workflow: WorkflowInfo;
  top: number;
  height: number;
  activeSessionId: string | null;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef) => void;
}

/**
 * A slim vertical panel docked between the workspace rail and the terminal,
 * carrying the selected workflow's full action set (including Visualize).
 * Top-aligned to that workflow's row and re-anchored whenever selection
 * moves (see useElementTopOffset) — the notch below erases the rail's
 * border for exactly the row's height so the row's highlight visually
 * flows into the strip, reading as one connected tab.
 */
export function WorkflowActionStrip({
  workflow,
  top,
  height,
  activeSessionId,
  macros,
  onRunMacro,
}: WorkflowActionStripProps): JSX.Element {
  const notchStyle: CSSProperties = { top, height };
  const stripStyle: CSSProperties = { top };

  return (
    <>
      <div className="workflow-action-strip-notch" style={notchStyle} data-testid="workflow-action-strip-notch" />
      <div className="workflow-action-strip" style={stripStyle} data-testid="workflow-action-strip">
        <MacroButtons macros={macros} workflow={workflow} activeSessionId={activeSessionId} onRun={onRunMacro} size={15} />
      </div>
    </>
  );
}
