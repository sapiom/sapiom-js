/**
 * run-state — fetches a prod execution projection from the agents surface and
 * renders it to a {@link RunView} the canvas can poll.
 *
 * WHY the agents surface: deployed agent runs are owned by the agents runtime
 * (`GET /agents/v1/executions/:id`), not the core-capabilities surface. The
 * response is the full ExecutionProjection JSON (same shape agent-core's
 * decodeExecutionProjection consumes).
 *
 * WHY the key stays server-side: the Sapiom API key is a harness credential that
 * must never reach the browser. The harness server fetches on behalf of the
 * canvas, so the SPA polls a local `/api/runs/:id/state` endpoint (no key in the
 * request) rather than calling the upstream surface directly.
 *
 * NOTE: this env-precedence helper for the agents base URL is duplicated
 * elsewhere in the harness; consolidate into one shared helper when convenient.
 */

import { decodeExecutionProjection } from "@sapiom/agent-core";

import type { RunView } from "../shared/types.js";
import { renderRunState } from "./render-run-state.js";

/** Resolve the agents surface base URL from the environment. */
export function resolveAgentsBaseUrl(): string {
  return (
    process.env.SAPIOM_AGENTS_URL ??
    process.env.SAPIOM_TOOLS_BASE ??
    "https://tools.sapiom.ai"
  );
}

export type RunStateResult =
  | { ok: true; runView: RunView }
  | { ok: false; status: number; error: string };

export interface RunStateFetcherOpts {
  apiKey: string | null;
  baseUrl?: string;
  /** Injectable fetch implementation — defaults to global fetch. Test seam. */
  fetchImpl?: typeof fetch;
}

export interface RunStateFetcher {
  fetch(executionId: string): Promise<RunStateResult>;
}

/**
 * Create a fetcher that resolves an execution's current render state from the
 * agents surface. The fetcher is intentionally non-throwing: all error paths
 * return a typed {@link RunStateResult} with `ok: false` so the router can
 * forward the appropriate HTTP status without a try/catch at the call site.
 */
export function createRunStateFetcher(
  opts: RunStateFetcherOpts,
): RunStateFetcher {
  const { apiKey, baseUrl = resolveAgentsBaseUrl(), fetchImpl = fetch } = opts;

  return {
    async fetch(executionId: string): Promise<RunStateResult> {
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
          `${baseUrl}/agents/v1/executions/${encodeURIComponent(executionId)}`,
          { headers: { "x-sapiom-api-key": apiKey } },
        );
      } catch {
        return { ok: false, status: 502, error: "gateway unreachable" };
      }

      if (res.status === 404) {
        return { ok: false, status: 404, error: "execution not found" };
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
        const runView = renderRunState(decodeExecutionProjection(raw));
        return { ok: true, runView };
      } catch {
        return { ok: false, status: 502, error: "could not decode execution" };
      }
    },
  };
}
