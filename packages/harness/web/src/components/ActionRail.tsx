import { useState } from "react";
import type { JSX } from "react";
import type { MacroDef } from "@shared/types";

import { Icon } from "./Icon";

interface ActionRailProps {
  macros: MacroDef[];
  disabledReasonFor: (macro: MacroDef) => string | null;
  onRun: (macro: MacroDef, subject?: string) => void;
}

function needsSubject(macro: MacroDef): boolean {
  return macro.action.kind === "inject" && macro.action.text.includes("{{subject}}");
}

export function ActionRail({ macros, disabledReasonFor, onRun }: ActionRailProps): JSX.Element {
  const [subjectFor, setSubjectFor] = useState<MacroDef | null>(null);
  const [subject, setSubject] = useState("");

  const handleClick = (macro: MacroDef): void => {
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
    <aside className="rail rail-actions">
      {macros.map((macro) => {
        const disabledReason = disabledReasonFor(macro);
        return (
          <button
            key={macro.id}
            className="action-icon-btn"
            aria-label={macro.label}
            data-testid={`macro-${macro.id}`}
            data-tooltip={disabledReason ?? macro.label}
            disabled={Boolean(disabledReason)}
            onClick={() => handleClick(macro)}
          >
            <Icon name={macro.icon} size={18} />
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
    </aside>
  );
}
