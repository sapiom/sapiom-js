import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";

import { isMockMode } from "../lib/api";
import { formatCostExact } from "../lib/run-cost";
import type { ObservedRun } from "../lib/use-harness-state";
import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";

const SAPIOM_BILLING_URL = "https://app.sapiom.ai";

/** The demo workspace's scripted starting credit. A real number the mock
 *  spends against, not a placeholder: live mode never shows it. */
const DEMO_CREDIT_USD = 20;

interface WalletCardProps {
  /** EVERY run observed this Studio session, keyed by executionId — entries
   *  update while a run polls but are never dropped, so the summed spend
   *  can only grow (a new run must never shrink displayed spend). */
  runsByExecution: Map<string, ObservedRun>;
  organizationName: string | null;
  onToast: (message: string) => void;
}

/**
 * Compact wallet card above the account footer: spend observed this Studio
 * session (summed across every run of every session), and a balance line.
 * Costs follow the app's honesty rule: when no observed step carried a cost
 * there is no number to show, so the spend line says so instead of
 * fabricating $0.00. Live mode has no balance endpoint yet, so balance reads
 * "Not connected" rather than a fake figure.
 */
export function WalletCard({ runsByExecution, organizationName, onToast }: WalletCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Sum captured cost across every step of EVERY observed run — keyed by
  // executionId upstream, so past runs keep counting after a new one starts.
  // Steps without costUsd contribute nothing AND don't count as billed - a
  // session full of free local runs stays honestly absent.
  let total = 0;
  let billedSteps = 0;
  runsByExecution.forEach(({ run }) => {
    for (const step of run.steps) {
      if (step.costUsd !== undefined) {
        total += step.costUsd;
        billedSteps += 1;
      }
    }
  });
  // Float sums drift (0.003 + 0.0125 !== 0.0155 in binary); settle at
  // micro-dollar precision before formatting.
  const spend = billedSteps > 0 ? Math.round(total * 1e6) / 1e6 : null;

  const demo = isMockMode();
  const balance = DEMO_CREDIT_USD - (spend ?? 0);

  return (
    <div className="wallet-card" data-testid="wallet-card">
      <div className="wallet-header">
        <span className="wallet-title">
          <Icon name="Wallet" size={13} />
          Wallet
        </span>
        <button
          ref={menuTriggerRef}
          className="wallet-menu-btn"
          data-testid="wallet-menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Wallet actions"
          title="Wallet actions"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name="MoreHorizontal" size={14} />
        </button>
      </div>

      {/* Portaled (AnchoredPopover): the wallet hugs the rail's bottom, so
          an in-tree panel could clip against the rail's edges. */}
      <AnchoredPopover
        open={menuOpen}
        anchorRef={menuTriggerRef}
        onDismiss={closeMenu}
        placement="up-end"
        className="wallet-menu"
        role="menu"
        testid="wallet-menu-popover"
      >
          <button
            role="menuitem"
            className="profile-menu-item"
            data-testid="wallet-open-billing"
            onClick={() => {
              window.open(SAPIOM_BILLING_URL, "_blank", "noopener,noreferrer");
              closeMenu();
            }}
          >
            <Icon name="ExternalLink" size={13} />
            Open billing
          </button>
          {organizationName && (
            <button
              role="menuitem"
              className="profile-menu-item"
              data-testid="wallet-copy-org"
              onClick={() => {
                // The org's name is the only identifier the harness state
                // exposes today; swap to the real id when the billing API
                // starts returning one.
                void navigator.clipboard
                  ?.writeText(organizationName)
                  .then(() => onToast("Organization id copied."))
                  .catch(() => onToast("Couldn't copy the organization id."));
                closeMenu();
              }}
            >
              <Icon name="Copy" size={13} />
              Copy organization id
            </button>
          )}
      </AnchoredPopover>

      <div className="wallet-body">
        <div className="wallet-line" data-testid="wallet-spend">
          {/* "Observed": only runs seen by this Studio session count — runs
              before this page load (or from elsewhere) can't be summed
              honestly, and the label must not claim account-level truth. */}
          <span
            className="wallet-line-label"
            data-tooltip="Costs from every run observed in this Studio session. Runs before this page load are not included."
          >
            Observed spend
          </span>
          {spend !== null ? (
            <span className="wallet-line-value">{formatCostExact(spend)}</span>
          ) : (
            <span className="wallet-line-quiet">No billed runs yet</span>
          )}
        </div>
        <div className="wallet-line" data-testid="wallet-balance">
          <span className="wallet-line-label">Balance</span>
          {demo ? (
            <span className="wallet-line-value">{`$${balance.toFixed(2)}`}</span>
          ) : (
            <span
              className="status-tag wallet-line-quiet"
              data-tooltip="Balance arrives with the billing API. Observed spend is computed from runs seen this Studio session."
            >
              <span className="status-tag-dot" aria-hidden="true" />
              Not connected
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
