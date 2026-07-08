import { useState } from "react";
import type { JSX, MouseEvent } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { macroDisabledReason, needsSubject } from "../lib/macro-gating";
import { Icon } from "./Icon";

interface MacroButtonsProps {
  macros: MacroDef[];
  workflow: WorkflowInfo | null;
  activeSessionId: string | null;
  onRun: (macro: MacroDef, subject?: string) => void;
  size?: number;
  /** Distinguishes repeated per-row instances (e.g. one per workflow row) — omit for a single instance (the bound-workflow header). */
  testIdPrefix?: string;
}

/**
 * A row of macro icon buttons, config-driven from MacroDef[] — used both as
 * per-workflow-row hover actions (compact, no Visualize — anything needing a
 * subject stays out) and as the full set in the bound-workflow header above
 * the canvas. Callers control layout via their own wrapping element.
 */
export function MacroButtons({
  macros,
  workflow,
  activeSessionId,
  onRun,
  size = 16,
  testIdPrefix = "",
}: MacroButtonsProps): JSX.Element {
  const [subjectFor, setSubjectFor] = useState<MacroDef | null>(null);
  const [subject, setSubject] = useState("");

  const handleClick = (e: MouseEvent, macro: MacroDef): void => {
    e.stopPropagation(); // row actions sit inside a clickable row — don't also trigger row selection
    if (needsSubject(macro)) {
      setSubjectFor(macro);
      setSubject("");
      return;
    }
    onRun(macro);
  };

  const submitSubject = (): void => {
    if (!subjectFor) return;
    onRun(subjectFor, subject.trim() || undefined);
    setSubjectFor(null);
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

      {subjectFor && (
        <div className="modal-backdrop" onClick={() => setSubjectFor(null)}>
          <div className="modal modal-subject" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">{subjectFor.label}</div>
            <input
              autoFocus
              className="modal-input"
              placeholder="What should the agent visualize?"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSubject();
                if (e.key === "Escape") setSubjectFor(null);
              }}
            />
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setSubjectFor(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={submitSubject}>
                Run
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
