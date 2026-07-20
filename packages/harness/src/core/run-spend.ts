/**
 * run-spend — fetches the cost/spend summary for a prod execution from the
 * core surface and maps it to a {@link RunSpend} the canvas can poll.
 *
 * WHY the core surface: the spend endpoint lives at
 * `GET /v1/workflows/executions/:id/spend` on api.sapiom.ai (the CORE
 * capability surface), which is distinct from the agents surface
 * (tools.sapiom.ai) that run-state.ts uses.  The same caveat applies:
 * env-consistency with the run's environment matters — both surfaces must be
 * overridden together when pointing at non-prod.
 *
 * WHY the key stays server-side: same rationale as run-state.ts — the Sapiom
 * API key is a harness credential that must never reach the browser.  The
 * harness server fetches on behalf of the canvas, so the SPA polls a local
 * `/api/runs/:id/spend` endpoint (no key in the request) rather than calling
 * the upstream surface directly.
 */

import type { RunSpend } from "../shared/types.js";
import { resolveAgentsBaseUrl } from "./run-state.js";

/**
 * Resolve the CORE surface base URL for the spend endpoint.
 *
 * The spend endpoint lives on the CORE host (`api.<env>`), distinct from the
 * agents host run-state.ts uses (`tools.<env>`). Crucially, a run lives in the
 * agents env, and its spend must be read from the MATCHING core env — otherwise
 * a prod run's spend queried against dev 401s. So we DERIVE the core host from
 * the agents host (`tools.<env>` → `api.<env>`) rather than reading
 * `SAPIOM_API_URL`, which in some setups points at a different env than the
 * agents surface. An explicit `SAPIOM_CORE_URL` still wins for full control.
 */
export function resolveCoreBaseUrl(): string {
  const override = process.env.SAPIOM_CORE_URL;
  if (override) return override;
  const agents = resolveAgentsBaseUrl();
  try {
    const url = new URL(agents);
    if (url.hostname.startsWith("tools.")) {
      url.hostname = `api.${url.hostname.slice("tools.".length)}`;
      return url.origin;
    }
  } catch {
    // Unparseable agents URL — fall through to the prod default.
  }
  return "https://api.sapiom.ai";
}

export type RunSpendResult =
  | { ok: true; spend: RunSpend }
  | { ok: false; status: number; error: string };

export interface RunSpendFetcherOpts {
  apiKey: string | null;
  baseUrl?: string;
  /** Injectable fetch implementation — defaults to global fetch. Test seam. */
  fetchImpl?: typeof fetch;
}

export interface RunSpendFetcher {
  fetch(executionId: string): Promise<RunSpendResult>;
}

/**
 * Create a fetcher that resolves an execution's spend/cost from the core
 * surface. The fetcher is intentionally non-throwing: all error paths return
 * a typed {@link RunSpendResult} with `ok: false` so the router can forward
 * the appropriate HTTP status without a try/catch at the call site.
 */
export function createRunSpendFetcher(
  opts: RunSpendFetcherOpts,
): RunSpendFetcher {
  const { apiKey, baseUrl = resolveCoreBaseUrl(), fetchImpl = fetch } = opts;

  return {
    async fetch(executionId: string): Promise<RunSpendResult> {
      // No API key — do not touch the network; the harness is not signed in.
      if (!apiKey) {
        return {
          ok: false,
          status: 503,
          error: "harness is not signed in to Sapiom",
        };
      }

      let res: Response;
      try {
        res = await fetchImpl(
          `${baseUrl}/v1/workflows/executions/${encodeURIComponent(executionId)}/spend`,
          { headers: { "x-api-key": apiKey } },
        );
      } catch {
        return { ok: false, status: 502, error: "gateway unreachable" };
      }

      if (res.status === 404) {
        return { ok: false, status: 404, error: "spend not found" };
      }

      if (!res.ok) {
        return {
          ok: false,
          status: 502,
          error: `gateway responded ${res.status}`,
        };
      }

      try {
        const raw = (await res.json()) as Record<string, unknown>;

        // The response is ExecutionSpendDto — we map the capability sub-object
        // fields to RunSpend, falling back to top-level totalUsd when needed.
        const capability = raw.capability as
          | Record<string, unknown>
          | undefined;

        const totalUsd: string =
          (capability?.totalUsd as string | undefined) ??
          (raw.totalUsd as string | undefined) ??
          "0";

        const settleState: string =
          (capability?.settleState as string | undefined) ?? "pending";

        const rawByStep = (capability?.byStep as unknown[] | undefined) ?? [];
        const byStep = rawByStep.map((s) => {
          const step = s as Record<string, unknown>;
          return {
            name: step.stepName as string,
            totalUsd: step.totalUsd as string,
            entryCount: step.entryCount as number,
          };
        });

        const spend: RunSpend = { executionId, totalUsd, settleState, byStep };
        return { ok: true, spend };
      } catch {
        return { ok: false, status: 502, error: "could not decode spend" };
      }
    },
  };
}
