import type { RefObject } from "react";
import type { JSX } from "react";

import type { RunTarget } from "../lib/use-harness-state";
import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";

interface RunTargetMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  selected: RunTarget;
  cloudDisabledReason: string | null;
  onDismiss: () => void;
  onSelect: (target: RunTarget) => void;
}

const TARGETS = [
  {
    id: "local" as const,
    label: "Local",
    description: "Agent code runs here with Sapiom calls stubbed",
    icon: "SquareTerminal",
  },
  {
    id: "prod" as const,
    label: "Cloud",
    description: "Run the deployed agent with real capabilities",
    icon: "Cloud",
  },
];

/** The target picker owns its two-line row layout. It deliberately does not
 * reuse profile-menu rows: those have a fixed one-line height, which is what
 * caused target descriptions to overlap the next option. */
export function RunTargetMenu({
  open,
  anchorRef,
  selected,
  cloudDisabledReason,
  onDismiss,
  onSelect,
}: RunTargetMenuProps): JSX.Element {
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onDismiss={onDismiss}
      placement="down-end"
      className="canvas-run-menu session-run-menu"
      role="menu"
      testid="session-run-target-menu"
    >
      {TARGETS.map((target) => {
        const disabledReason = target.id === "prod" ? cloudDisabledReason : null;
        const isSelected = selected === target.id;
        return (
          <button
            key={target.id}
            className="run-target-option"
            data-selected={isSelected || undefined}
            data-testid={target.id === "prod" ? "session-step-run" : "run-target-local"}
            type="button"
            role="menuitemradio"
            aria-checked={isSelected}
            disabled={Boolean(disabledReason)}
            title={disabledReason ?? undefined}
            onClick={() => onSelect(target.id)}
          >
            <Icon name={target.icon} size={15} />
            <span className="run-target-copy">
              <strong>{target.label}</strong>
              <small>{disabledReason ?? target.description}</small>
            </span>
            <span className="run-target-check" aria-hidden="true">
              {isSelected && <Icon name="Check" size={13} />}
            </span>
          </button>
        );
      })}
    </AnchoredPopover>
  );
}
