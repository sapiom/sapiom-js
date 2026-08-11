/**
 * account-plan — the rail's plan card, read from the Sapiom CORE surface so it
 * can never disagree with the dashboard's own billing views.
 *
 * Three reads, folded into one `AccountPlanView`:
 *
 *  - `GET /v1/dashboard/plan`                        → plan name + status
 *  - `GET /v1/spending-rules/spend-limit-summary`    → today's settled spend vs
 *    the org's spend-limit rule — the exact "$used / $cap" pair the dashboard's
 *    balance card renders (JSON:API envelope; all-null attributes when no rule)
 *  - `GET /v1/accounts/spend`                        → `availableBalanceUsd`,
 *    the prepaid fallback when no limit rule exists
 *
 * Same auth contract as template-catalog.ts (and verified there): core takes
 * `Authorization: Bearer`, NOT the agents surface's `x-sapiom-api-key`, and
 * every path is prefixed `/v1`. The key stays server-side; a 401/403 triggers
 * exactly one credential refresh + retry.
 *
 * These endpoints are excluded from core's public OpenAPI surface, so their
 * shapes are contracts by observation, not by document. Every field is
 * narrowed defensively and any drift degrades the readout to `none` (or the
 * whole view to `fallback`) rather than throwing — a broken billing read must
 * never take the rail down.
 */

import type { AccountPlanView } from "../shared/types.js";
import {
  type ApiKeyProvider,
  staticApiKeyProvider,
} from "./api-key-provider.js";
import { resolveCoreBaseUrl } from "./definition-slug-resolver.js";

/** Mirrors template-catalog.ts: statuses worth one refresh + retry. */
function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** How long a successful view is reused. Spend moves on the order of runs, not
 *  keystrokes; the dashboard's own hooks poll at 30–60s, and the SPA re-asks on
 *  its own cadence — a short TTL just absorbs bursts (mount + auth flip). */
const CACHE_TTL_MS = 60_000;

export interface AccountPlanReader {
  /** The assembled card view. Never throws: signed-out and unreachable both
   *  come back as `source: "fallback"` with an honest empty readout. */
  view(): Promise<AccountPlanView>;
}

/** Unknown-shaped JSON from upstream, narrowed field by field below. */
type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A finite number, from a JSON number or a decimal string (the ledger returns
 *  decimal(36,18) strings; the spend read model returns numbers). */
function usd(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `{ data: { plan: { name, status } | null } }` → the card's plan line. */
export function extractPlan(body: unknown): AccountPlanView["plan"] {
  const plan = asObject(asObject(asObject(body)?.data)?.plan);
  if (!plan || typeof plan.name !== "string" || plan.name === "") return null;
  return { name: plan.name, status: plan.status === "active" ? "active" : "inactive" };
}

/** JSON:API `{ data: { attributes: { limitUsd, windowSpendUsd } } }` → the
 *  "$used / $cap" pair, or null when no qualifying rule exists (all-null
 *  attributes is that endpoint's documented "no rule" answer, not an error). */
export function extractLimit(
  body: unknown,
): { usedUsd: number; limitUsd: number } | null {
  const attrs = asObject(asObject(asObject(body)?.data)?.attributes);
  if (!attrs) return null;
  const limitUsd = usd(attrs.limitUsd);
  const usedUsd = usd(attrs.windowSpendUsd);
  if (limitUsd === null || usedUsd === null) return null;
  return { usedUsd, limitUsd };
}

/** `{ data: { availableBalanceUsd } }` → the prepaid balance, or null. */
export function extractBalance(body: unknown): number | null {
  return usd(asObject(asObject(body)?.data)?.availableBalanceUsd);
}

export function createAccountPlanReader(opts: {
  /** Accepts a provider (preferred — enables refresh-on-401) or a bare key. */
  apiKey: string | null | ApiKeyProvider;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam. */
  fetchImpl?: typeof fetch;
}): AccountPlanReader {
  const provider: ApiKeyProvider =
    opts.apiKey !== null && typeof opts.apiKey === "object"
      ? opts.apiKey
      : staticApiKeyProvider(opts.apiKey);
  const baseUrl = opts.baseUrl ?? resolveCoreBaseUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;

  let cache: { at: number; value: AccountPlanView } | null = null;
  // One line per distinct failure reason, not per poll — the SPA re-asks every
  // minute and a persistent misconfiguration shouldn't flood the log.
  const logged = new Set<string>();
  const warnOnce = (reason: string): void => {
    if (logged.has(reason)) return;
    logged.add(reason);
    console.error(
      `[harness] account plan unavailable from ${baseUrl} (${reason}); ` +
        "the rail hides the plan card — check the harness is signed in " +
        "and SAPIOM_CORE_URL points at a reachable Sapiom API",
    );
  };

  /**
   * GET `path` from the core surface with the held key, refreshing + retrying
   * once on an auth rejection. Returns the parsed body, or null on any failure.
   */
  const getJson = async (path: string): Promise<unknown | null> => {
    let apiKey = provider.getKey();
    if (!apiKey) return null;

    const attempt = async (key: string): Promise<Response | null> => {
      try {
        return await fetchImpl(`${baseUrl}${path}`, {
          // Core (`api.*`) takes a Bearer token — see template-catalog.ts.
          headers: { Authorization: `Bearer ${key}` },
        });
      } catch (err) {
        warnOnce(err instanceof Error ? err.message : String(err));
        return null;
      }
    };

    let response = await attempt(apiKey);
    if (!response) return null;

    if (isAuthRejection(response.status)) {
      const refreshed = await provider.refresh();
      if (refreshed && refreshed !== apiKey) {
        apiKey = refreshed;
        response = await attempt(refreshed);
        if (!response) return null;
      }
    }

    if (!response.ok) {
      warnOnce(`HTTP ${response.status} on ${path}`);
      return null;
    }
    try {
      return await response.json();
    } catch {
      warnOnce("response body was not JSON");
      return null;
    }
  };

  return {
    async view(): Promise<AccountPlanView> {
      const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
      if (fresh && cache) return cache.value;

      // Signed out is an expected state (a harness launched without auth), not
      // a fault — the card simply doesn't render.
      if (!provider.getKey()) {
        return { plan: null, readout: { kind: "none" }, source: "fallback", reason: "signed-out" };
      }

      // Three independent reads; each may fail alone. A plan with no numbers
      // and numbers with no plan are both better than nothing, so partial
      // success builds a partial view instead of discarding what answered.
      const [planBody, limitBody, spendBody] = await Promise.all([
        getJson("/v1/dashboard/plan"),
        getJson("/v1/spending-rules/spend-limit-summary"),
        getJson("/v1/accounts/spend"),
      ]);

      if (planBody === null && limitBody === null && spendBody === null) {
        // Nothing answered — unreachable (or every shape drifted). Not cached:
        // the next poll should get to try again.
        return { plan: null, readout: { kind: "none" }, source: "fallback", reason: "unreachable" };
      }

      const plan = extractPlan(planBody);
      const limit = extractLimit(limitBody);
      const balance = extractBalance(spendBody);
      const readout: AccountPlanView["readout"] = limit
        ? { kind: "limit", ...limit }
        : balance !== null
          ? { kind: "balance", availableUsd: balance }
          : { kind: "none" };

      const value: AccountPlanView = { plan, readout, source: "live" };
      cache = { at: Date.now(), value };
      return value;
    },
  };
}
