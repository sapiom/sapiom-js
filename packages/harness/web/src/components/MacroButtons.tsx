import type { JSX, MouseEvent } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { macroDisabledReason } from "../lib/macro-gating";
import { Icon } from "./Icon";

interface MacroButtonsProps {
  macros: MacroDef[];
  workflow: WorkflowInfo | null;
  activeSessionId: string | null;
  onRun: (macro: MacroDef) => void;
  size?: number;
  /** Distinguishes repeated per-row instances (e.g. one per workflow row) — omit for a single instance (the bound-workflow header). */
  testIdPrefix?: string;
}

/**
 * A row of macro icon buttons, config-driven from MacroDef[] — used both as
 * per-workflow-row hover actions (compact, no Visualize — see rowMacros in
 * WorkflowsRail) and as the full set in the bound-workflow header above the
 * canvas. Every macro is one click and done — the agent is the interface for
 * anything that needs more input than that. Callers control layout via their
 * own wrapping element.
 */
export function MacroButtons({
  macros,
  workflow,
  activeSessionId,
  onRun,
  size = 16,
  testIdPrefix = "",
}: MacroButtonsProps): JSX.Element {
  const handleClick = (e: MouseEvent, macro: MacroDef): void => {
    e.stopPropagation(); // row actions sit inside a clickable row — don't also trigger row selection
    onRun(macro);
  };

  return (
    <>
      {macros.map((macro) => {
        const disabledReason = macroDisabledReason(macro, workflow, activeSessionId);
        return (
          <button
            key={macro.id}
            className="macro-icon-btn"
            aria-label={macro.label}
            data-testid={`${testIdPrefix}macro-${macro.id}`}
            data-tooltip={disabledReason ?? macro.label}
            disabled={Boolean(disabledReason)}
            onClick={(e) => handleClick(e, macro)}
          >
            <Icon name={macro.icon} size={size} />
          </button>
        );
      })}
    </>
  );
}
