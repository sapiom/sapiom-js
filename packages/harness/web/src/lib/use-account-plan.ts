/**
 * The rail's plan card data: `GET /api/account/plan`, re-read when the auth
 * state flips and on a slow poll while the app stays open.
 *
 * Returns the view or null — null covers loading, errors, AND the degraded
 * `readout: none` + `plan: null` answer, because the card's contract is to
 * render nothing rather than a fabricated number (see PlanCard). The refetch
 * key is the `authenticated` prop the rail already receives (updated in place
 * by the `auth.changed` bus message in use-harness-state), so this hook needs
 * no second events subscription.
 */
import { useEffect, useState } from "react";
import type { AccountPlanView } from "@shared/types";

import { createApi } from "./api";

/** Matches the dashboard's own billing-hook cadence (30–60s); the server adds
 *  a 60s TTL of its own, so a shorter interval here would just hit that cache. */
const REFRESH_INTERVAL_MS = 60_000;

const api = createApi();

/** True when there is anything worth pinning to the rail. */
function hasContent(view: AccountPlanView): boolean {
  return view.plan !== null || view.readout.kind !== "none";
}

export function useAccountPlan(authenticated: boolean): AccountPlanView | null {
  const [view, setView] = useState<AccountPlanView | null>(null);

  useEffect(() => {
    // Guards against a late response landing after sign-out flipped the key —
    // the card must not keep showing the previous account's numbers.
    let cancelled = false;
    // An auth flip invalidates whatever is showing NOW, not just future reads:
    // sign-out must drop the old account's numbers before the (signed-out)
    // answer comes back, not after.
    setView(null);
    const load = (): void => {
      api.getAccountPlan().then(
        (next) => {
          if (!cancelled) setView(hasContent(next) ? next : null);
        },
        () => {
          // A failed read hides the card rather than surfacing an error: plan
          // data is ambient, and the rail is not the place to report billing
          // connectivity. The next tick (or auth flip) retries.
          if (!cancelled) setView(null);
        },
      );
    };
    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authenticated]);

  return view;
}
