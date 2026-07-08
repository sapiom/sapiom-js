import type { CSSProperties, JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { macroDisabledReason } from "../lib/macro-gating";
import { Icon } from "./Icon";

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
 *
 * Icon-only at rest; hovering it, OR focusing anything inside it (:focus-
 * within, so tabbing in gets the same reveal a mouse hover gets), expands
 * it into a floating icon+label panel over the terminal — full labels (and
 * a gated item's disabled reason) without permanently costing the terminal
 * any width.
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
        {macros.map((macro) => {
          const disabledReason = macroDisabledReason(macro, workflow, activeSessionId);
          return (
            <button
              key={macro.id}
              className="strip-item"
              data-testid={`macro-${macro.id}`}
              aria-label={disabledReason ? `${macro.label}: ${disabledReason}` : macro.label}
              disabled={Boolean(disabledReason)}
              onClick={() => onRunMacro(macro)}
            >
              <span className="strip-item-icon">
                <Icon name={macro.icon} size={15} />
              </span>
              <span className="strip-item-text">
                <span className="strip-item-label">{macro.label}</span>
                {disabledReason && <span className="strip-item-reason">{disabledReason}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
