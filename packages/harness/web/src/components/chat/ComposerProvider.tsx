/**
 * Provider control in the composer footer — a REAL dropdown, honestly
 * scoped: this session's agent is pinned at launch (a pty can't swap
 * binaries mid-conversation), so the switch applies to NEW sessions. The
 * pick persists as the new-session dialog's default agent (ui-prefs), and
 * the trigger's tooltip says exactly that — no dead select pretending
 * otherwise.
 *
 * The menu reads the live adapter registry (GET /api/harnesses) the first
 * time it opens: every adapter the server knows about renders, the ones the
 * Studio can't launch disabled with the reason on hover. Until (or in case)
 * the fetch resolves, the fallback pair keeps demo mode and older servers
 * behaving exactly as before.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { HarnessEntry, HarnessKind } from "@shared/types";

import { FALLBACK_HARNESSES, orderHarnesses } from "../../lib/harness-registry";
import { HARNESS_LABELS } from "../../lib/history-meta";
import { loadUiPrefs, saveUiPrefs } from "../../lib/ui-prefs";
import { AnchoredPopover } from "../AnchoredPopover";
import { HarnessBrandIcon } from "../HarnessBrandIcon";
import { HarnessMenuItems } from "../HarnessMenuItems";
import { Icon } from "../Icon";

export interface ComposerProviderProps {
  /** The session's pinned agent — what the trigger names. */
  harness: HarnessKind;
  /** Adapter registry fetch — absent (older callers) keeps the fallback pair. */
  listHarnesses?: () => Promise<HarnessEntry[]>;
}

export const ComposerProvider = ({ harness, listHarnesses }: ComposerProviderProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HarnessEntry[]>(FALLBACK_HARNESSES);
  // One successful fetch is enough; failures retry on the next open.
  const fetchedRef = useRef(false);
  // What NEW sessions will run — defaults to this session's agent until the
  // user picks otherwise.
  const [preferred, setPreferred] = useState<HarnessKind>(
    () => loadUiPrefs().preferredHarness ?? harness,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const agentLabel = HARNESS_LABELS[harness];

  // Fetch on open, not mount: the composer renders on every session while
  // the menu is rarely opened, and open-time reads keep installed flags fresh.
  useEffect(() => {
    if (!open || fetchedRef.current || !listHarnesses) return;
    let cancelled = false;
    listHarnesses()
      .then((registry) => {
        if (cancelled || registry.length === 0) return;
        fetchedRef.current = true;
        setEntries(orderHarnesses(registry));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, listHarnesses]);

  const pick = (kind: HarnessKind): void => {
    setPreferred(kind);
    saveUiPrefs({ preferredHarness: kind });
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-provider"
        data-testid="composer-agent"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={`This session runs ${agentLabel}. The switch applies to new sessions.`}
        onClick={() => setOpen((v) => !v)}
      >
        <HarnessBrandIcon kind={harness} size={12} />
        {/* The word hides under the narrowest container query; the brand
            glyph + tooltip keep naming the agent. */}
        <span className="composer-agent-label">{agentLabel}</span>
        <span className={"disclosure-caret composer-provider-caret" + (open ? " is-open" : "")} aria-hidden="true">
          <Icon name="ChevronDown" size={12} />
        </span>
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={close}
        placement="up-end"
        className="session-menu composer-provider-menu"
        role="menu"
        testid="composer-provider-menu"
      >
        {/* The native mode leads: Sapiom Harness is the Studio's own chat
            pipeline — the surface this conversation runs on today — as
            opposed to the CLI agents below, which run the terminal and new
            sessions. It is checked because it IS the active chat mode (there
            is no other yet); picking it just confirms the default. Same row
            recipe as the adapters so the anatomy never drifts. */}
        <button
          type="button"
          role="menuitemradio"
          aria-checked="true"
          className="profile-menu-item provider-item"
          data-testid="composer-provider-sapiom"
          data-tooltip="The Studio's native chat pipeline. This conversation runs here today; CLI agents run the terminal."
          onClick={close}
        >
          <span className="provider-item-check" aria-hidden="true">
            <Icon name="Check" size={13} />
          </span>
          <HarnessBrandIcon kind="sapiom" size={13} />
          Sapiom Harness
        </button>
        <div className="provider-menu-divider" role="separator" aria-hidden="true" />
        <div className="session-dropdown-section">Agent for new sessions</div>
        <HarnessMenuItems
          entries={entries}
          activeId={preferred}
          testidPrefix="composer-provider"
          onPick={pick}
        />
      </AnchoredPopover>
    </>
  );
};
