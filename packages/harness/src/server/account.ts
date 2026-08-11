/**
 * Account router — backs GET /api/account/plan.
 *
 * Relays the signed-in org's plan + usage readout from Sapiom core to the
 * rail's plan card. The API key is held server-side and never forwarded to the
 * browser — the router reads on the card's behalf via
 * {@link createAccountPlanReader}, exactly as the templates router does for
 * the gallery (and for the same reason: the `sk_…` key must not reach the
 * page, and core sends no CORS headers for the harness's origin).
 */

import { Router } from "express";

import { createAccountPlanReader } from "../core/account-plan.js";
import { type ApiKeyProvider } from "../core/api-key-provider.js";

export interface AccountRouterOpts {
  /** The Sapiom API key (`sk_…`), NOT the local boot token. Pass a provider so
   *  a rejected key can refresh + retry instead of locking the card. */
  apiKey: string | null | ApiKeyProvider;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam. */
  fetchImpl?: typeof fetch;
}

export function createAccountRouter(opts: AccountRouterOpts): Router {
  const router = Router();
  const reader = createAccountPlanReader({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });

  /**
   * GET /api/account/plan
   *
   * 200 always — an `AccountPlanView`. Deliberately never an error status: a
   * signed-out or unreachable core is a hidden card, not a failed request.
   * `source`/`reason` carry the degradation for anything that wants to say so.
   */
  router.get("/api/account/plan", async (_req, res) => {
    res.json(await reader.view());
  });

  return router;
}
