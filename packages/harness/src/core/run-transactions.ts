/**
 * run-transactions — fetches the per-call cost drill-down for an execution
 * from the core surface and maps it to a {@link RunCall}[] the canvas shows
 * when a user clicks a step and asks "why is this costly".
 *
 * WHY this exists alongside run-spend: `/spend` gives per-STEP aggregates
 * (totalUsd + entryCount). This endpoint itemises the individual billable
 * capability calls that make up that total (e.g. "renderPdfs $7.95 = 1 sandbox
 * call"), which is what makes the debug macros actionable.
 *
 * WHY provider-agnostic: the raw upstream service name (the provider) is mapped
 * to a generic capability label here, server-side, so the browser never
 * receives — and this open-source file never hard-codes — a provider or model
 * name. See the capability-label heuristic below (keyed on generic op/resource
 * tokens, never a brand).
 *
 * WHY the key stays server-side: identical rationale to run-state / run-spend —
 * the Sapiom API key is a harness credential that must never reach the browser.
 */

import type { RunCall } from "../shared/types.js";
import { resolveCoreBaseUrl } from "./run-spend.js";

export type RunCallsResult =
  | { ok: true; calls: RunCall[] }
  | { ok: false; status: number; error: string };

export interface RunTransactionsFetcherOpts {
  apiKey: string | null;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch implementation — defaults to global fetch. Test seam. */
  fetchImpl?: typeof fetch;
}

export interface RunTransactionsFetcher {
  fetch(executionId: string): Promise<RunCallsResult>;
}

/**
 * Map a raw upstream operation/resource to a provider-agnostic capability
 * label. Keyed ONLY on generic tokens (message / sandbox / search) and the
 * operation verb — deliberately never on a provider/brand name, so this file
 * stays clean of internal service names and the label is stable if the
 * underlying provider is swapped. Unknown shapes fall back to the operation
 * verb, which is itself generic ("create", "execute", …).
 */
export function capabilityLabel(op: string, resource: string): string {
  const r = (resource ?? "").toLowerCase();
  if (op === "generate" || r.includes("message") || r.includes("completion")) {
    return "LLM";
  }
  if (r.includes("sandbox")) return "sandbox";
  if (r.includes("search")) return "web search";
  return op || "capability";
}

/** Sum the active, non-estimate captured USD across a transaction's cost rows. */
function activeCapturedUsd(costs: unknown[]): number {
  let total = 0;
  for (const c of costs) {
    const cost = c as Record<string, unknown>;
    if (cost.isActive === true && cost.isEstimate === false) {
      const n = Number(cost.fiatAmount);
      if (Number.isFinite(n)) total += n;
    }
  }
  return total;
}

/**
 * Create a fetcher that resolves an execution's per-call cost breakdown from
 * the core transactions endpoint. Like the spend fetcher, it is intentionally
 * non-throwing: every error path returns a typed {@link RunCallsResult} with
 * `ok: false` so the router forwards the status without a try/catch.
 *
 * Only BILLABLE calls are returned (active captured USD > 0) — the free
 * `workflows` orchestration rows are dropped as noise. Each call is attributed
 * to `metadata.workflowStepName ?? actionName` so the canvas can match it to a
 * step node.
 */
export function createRunTransactionsFetcher(
  opts: RunTransactionsFetcherOpts,
): RunTransactionsFetcher {
  const { apiKey, baseUrl = resolveCoreBaseUrl(), fetchImpl = fetch } = opts;

  return {
    async fetch(executionId: string): Promise<RunCallsResult> {
      if (!apiKey) {
        return {
          ok: false,
          status: 503,
          error: "harness is not signed in to Sapiom",
        };
      }

      // filter[trace_external_id] == the workflow execution id; page[limit] is
      // the endpoint's pagination knob (NOT `limit`/`page[size]`, which 400).
      const url =
        `${baseUrl}/v1/transactions` +
        `?filter[trace_external_id]=${encodeURIComponent(executionId)}` +
        `&page[limit]=100`;

      let res: Response;
      try {
        res = await fetchImpl(url, { headers: { "x-api-key": apiKey } });
      } catch {
        return { ok: false, status: 502, error: "gateway unreachable" };
      }

      if (res.status === 404) {
        return { ok: false, status: 404, error: "transactions not found" };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: 502,
          error: `gateway responded ${res.status}`,
        };
      }

      try {
        const body = (await res.json()) as { data?: unknown[] };
        const rows = Array.isArray(body.data) ? body.data : [];

        const calls: RunCall[] = [];
        for (const row of rows) {
          const t = row as Record<string, unknown>;
          const costs = Array.isArray(t.costs) ? (t.costs as unknown[]) : [];
          const usd = activeCapturedUsd(costs);
          if (usd <= 0) continue; // billable calls only — drop free orchestration

          const op = typeof t.actionName === "string" ? t.actionName : "";
          const resource =
            typeof t.resourceName === "string" ? t.resourceName : "";
          const metadata = (t.metadata as Record<string, unknown>) ?? {};
          const stepName =
            (typeof metadata.workflowStepName === "string" &&
              metadata.workflowStepName) ||
            op ||
            "unknown";

          calls.push({
            stepName,
            capability: capabilityLabel(op, resource),
            op,
            usd: usd.toFixed(6),
          });
        }

        return { ok: true, calls };
      } catch {
        return { ok: false, status: 502, error: "could not decode transactions" };
      }
    },
  };
}
