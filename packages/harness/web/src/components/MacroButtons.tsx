import type { JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { macroDisabledReason } from "../lib/macro-gating";
import { Icon } from "./Icon";

interface MacroButtonsProps {
  macros: MacroDef[];
  workflow: WorkflowInfo | null;
  activeSessionId: string | null;
  onRun: (macro: MacroDef) => void;
  size?: number;
}

/**
 * A row of macro icon buttons, config-driven from MacroDef[] — the docked
 * workflow action strip's full action set (run local, deploy, prod run,
 * open prod, visualize). Every macro is one click and done — the agent is
 * the interface for anything that needs more input than that.
 */
export function MacroButtons({ macros, workflow, activeSessionId, onRun, size = 16 }: MacroButtonsProps): JSX.Element {
  return (
    <>
      {macros.map((macro) => {
        const disabledReason = macroDisabledReason(macro, workflow, activeSessionId);
        return (
          <button
            key={macro.id}
            className="macro-icon-btn"
            aria-label={macro.label}
            data-testid={`macro-${macro.id}`}
            data-tooltip={disabledReason ?? macro.label}
            disabled={Boolean(disabledReason)}
            onClick={() => onRun(macro)}
          >
            <Icon name={macro.icon} size={size} />
          </button>
        );
      })}
    </>
  );
}
