/**
 * A menu row that PICKS one of a set, rather than doing something.
 *
 * Same anatomy as every other menu row (`.session-dropdown-item`) so the card
 * stays one list; what marks it is a check in the trailing gutter, and
 * `menuitemradio` so a screen reader is told it is a choice among peers and
 * which one is current. Shared by the rail's Group by and Sort choice sets.
 */
import type { JSX } from "react";

import { Icon } from "./Icon";

export interface MenuChoiceProps {
  testid: string;
  icon: string;
  label: string;
  checked: boolean;
  onPick: () => void;
}

export function MenuChoice({ testid, icon, label, checked, onPick }: MenuChoiceProps): JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-testid={testid}
      className={"session-dropdown-item menu-choice" + (checked ? " is-checked" : "")}
      onClick={onPick}
    >
      <span className="session-item-icon">
        <Icon name={icon} size={13} />
      </span>
      <span className="session-item-copy">
        <span className="session-item-title">{label}</span>
      </span>
      <span className="menu-choice-mark" aria-hidden="true">
        {checked && <Icon name="Check" size={13} />}
      </span>
    </button>
  );
}
