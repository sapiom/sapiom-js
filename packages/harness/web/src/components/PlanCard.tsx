/**
 * The rail's plan card: plan name over one money line, an Upgrade pill, and an
 * overflow menu of billing deep links — a shaded card pinned above the account
 * row (see styles.css `.rail-footer-card` for why the footer carries cards).
 *
 * The honesty rule survives the redesign: the card renders what the server's
 * `GET /api/account/plan` view states and NOTHING else — no invented spend,
 * quota, or plan. A view with neither a plan nor a readout renders null, which
 * is also the signed-out and unreachable state (`use-account-plan` collapses
 * those to null before this component ever sees them).
 *
 * All three actions are dashboard deep links because that is the entire action
 * space: checkout, plan changes, and top-ups are dashboard-session-only on the
 * platform, so the Studio's job ends at the right page.
 */
import { useCallback, useRef, useState, type JSX } from "react";
import type { AccountPlanView } from "@shared/types";

import { formatUsd } from "../lib/currency";
import { track } from "../lib/track";
import { SAPIOM_BILLING_URL, SAPIOM_USAGE_URL } from "../lib/urls";
import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";

/** The one money line, or null when the view carries nothing trustworthy. */
function readoutText(readout: AccountPlanView["readout"]): string | null {
  switch (readout.kind) {
    case "limit":
      // The dashboard's own pair: settled spend today against the org's
      // spend-limit rule.
      return `${formatUsd(readout.usedUsd)} / ${formatUsd(readout.limitUsd)}`;
    case "balance":
      return `${formatUsd(readout.availableUsd)} available`;
    case "none":
      return null;
  }
}

export function PlanCard({ plan }: { plan: AccountPlanView | null }): JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  if (!plan) return null;
  const money = readoutText(plan.readout);
  if (!plan.plan && !money) return null;

  return (
    <div className="rail-footer-row plan-row" data-testid="plan-card">
      <div className="rail-footer-card plan-card">
        <span className="plan-card-copy">
          {plan.plan && <span className="plan-card-name">{plan.plan.name}</span>}
          {money && (
            <span className="plan-card-readout" data-testid="plan-balance">
              {money}
            </span>
          )}
        </span>
        <a
          className="pill plan-card-upgrade"
          href={SAPIOM_BILLING_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="plan-upgrade"
          onClick={() => track("plan.upgrade_clicked")}
        >
          Upgrade
        </a>
        <button
          ref={menuRef}
          className="plan-card-menu-btn"
          data-testid="plan-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Plan options"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name="MoreVertical" size={13} />
        </button>
        <AnchoredPopover
          open={menuOpen}
          anchorRef={menuRef}
          onDismiss={closeMenu}
          placement="up-end"
          className="plan-menu"
          role="menu"
          testid="plan-menu"
        >
          <button
            role="menuitem"
            className="profile-menu-item"
            data-testid="plan-manage-billing"
            onClick={() => {
              window.open(SAPIOM_BILLING_URL, "_blank", "noopener,noreferrer");
              closeMenu();
            }}
          >
            <Icon name="ExternalLink" size={13} />
            Manage billing
          </button>
          <button
            role="menuitem"
            className="profile-menu-item"
            data-testid="plan-view-usage"
            onClick={() => {
              window.open(SAPIOM_USAGE_URL, "_blank", "noopener,noreferrer");
              closeMenu();
            }}
          >
            <Icon name="ExternalLink" size={13} />
            View usage
          </button>
        </AnchoredPopover>
      </div>
    </div>
  );
}
