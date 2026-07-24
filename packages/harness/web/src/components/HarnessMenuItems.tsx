/**
 * The ONE provider-menu row recipe, shared by the composer's dropdown and the
 * new-session picker so their anatomy can never drift.
 *
 * Row anatomy: [check slot][brand icon][label]. The active item carries the
 * leading check and nothing else — no "selected" suffix, no extra tag; the
 * slot stays reserved on every row so labels align. Adapters the Studio
 * can't launch stay listed (the registry is the truth about what exists) but
 * render disabled via aria-disabled — not the disabled attribute, which would
 * swallow the hover events the explanatory tooltip rides on.
 */
import type { JSX } from "react";
import type { HarnessEntry, HarnessKind } from "@shared/types";

import { harnessUnavailableReason, isHarnessSelectable } from "../lib/harness-registry";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { Icon } from "./Icon";

export interface HarnessMenuItemsProps {
  /** Registry entries in menu order (orderHarnesses already applied). */
  entries: HarnessEntry[];
  /** The id the leading check marks. */
  activeId: string;
  /** Row testids render as `${testidPrefix}-${entry.id}`. */
  testidPrefix: string;
  /** Called only for selectable entries — disabled rows never fire it. */
  onPick: (kind: HarnessKind) => void;
}

export function HarnessMenuItems({ entries, activeId, testidPrefix, onPick }: HarnessMenuItemsProps): JSX.Element {
  return (
    <>
      {entries.map((entry) => {
        const selectable = isHarnessSelectable(entry);
        const active = entry.id === activeId;
        const reason = harnessUnavailableReason(entry);
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            aria-disabled={!selectable || undefined}
            className={"profile-menu-item provider-item" + (selectable ? "" : " is-unavailable")}
            data-testid={`${testidPrefix}-${entry.id}`}
            data-tooltip={reason ?? undefined}
            onClick={() => {
              if (selectable) onPick(entry.id as HarnessKind);
            }}
          >
            <span className="provider-item-check" aria-hidden="true">
              {active && <Icon name="Check" size={13} />}
            </span>
            <HarnessBrandIcon kind={entry.id} size={13} />
            {entry.label}
          </button>
        );
      })}
    </>
  );
}
