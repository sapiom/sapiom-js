import type { JSX } from "react";

import { Icon } from "./Icon";

export interface AccountPlanSummary {
  name: string;
  statusLabel?: string;
  cta: { label: string; href: string } | null;
}

/** The Pages/demo fixture. Live mode passes `null` until the harness owns a
 *  typed plan contract — the rail never invents spend, quota, or a plan. */
export const DEMO_ACCOUNT_PLAN: AccountPlanSummary = {
  name: "Free plan",
  statusLabel: "Active",
  cta: {
    label: "Upgrade plan",
    href: "https://app.sapiom.ai/settings?tab=billing",
  },
};

/**
 * One factual plan summary and one way out, pinned above the account row as
 * part of the same footer block (no divider between them). Renders nothing
 * when there is no plan to state — only the explicit demo fixture supplies one.
 */
export function PlanCard({ plan }: { plan: AccountPlanSummary | null }): JSX.Element | null {
  if (!plan) return null;

  const content = (
    <>
      <span className="rail-profile-copy">
        <span className="rail-profile-name">{plan.name}</span>
        {plan.statusLabel && <span className="rail-profile-meta">{plan.statusLabel}</span>}
      </span>
      {plan.cta && <span className="pill">{plan.cta.label}</span>}
      {plan.cta && <Icon name="ArrowUpRight" size={14} />}
    </>
  );

  return (
    <div className="rail-footer-row plan-row" data-testid="plan-card">
      {plan.cta ? (
        <a
          className="rail-plan-card"
          href={plan.cta.href}
          target="_blank"
          rel="noreferrer"
          data-testid="plan-upgrade"
        >
          {content}
        </a>
      ) : (
        <div className="rail-plan-card">{content}</div>
      )}
    </div>
  );
}
