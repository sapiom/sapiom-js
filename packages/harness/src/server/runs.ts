/**
 * Runs router — backs GET /api/runs/:executionId/{state,spend,transactions}.
 *
 * Returns a {@link RunView} (live status), {@link RunSpend} (per-step cost), or
 * per-call {@link RunCall}[] (cost drill-down) for a running or finished prod
 * agents execution, so the web canvas can poll live status, cost, and the
 * "why is this costly" breakdown. The Sapiom API key is held server-side and
 * never forwarded to the browser — the router fetches on behalf of the canvas
 * via {@link createRunStateFetcher}, {@link createRunSpendFetcher}, and
 * {@link createRunTransactionsFetcher}.
 */

import { Router } from "express";

import { createRunStateFetcher } from "../core/run-state.js";
import { createRunSpendFetcher } from "../core/run-spend.js";
import { createRunTransactionsFetcher } from "../core/run-transactions.js";

export interface RunsRouterOpts {
  /** Sapiom API key for the agents surface; null when the harness is not authenticated. */
  apiKey: string | null;
  /** Override the agents base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Override the core base URL for the spend endpoint (resolved from env by default). Test seam. */
  coreBaseUrl?: string;
  /**
   * Injectable fetch implementation forwarded to the fetcher. Undocumented for
   * prod — exists as a test seam only, mirroring the pattern used elsewhere in
   * the harness resolver suite.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Create the runs router. Mounts `GET /api/runs/:executionId/state` and
 * `GET /api/runs/:executionId/spend`, delegating to the respective fetchers
 * for each upstream call.
 */
export function createRunsRouter(opts: RunsRouterOpts): Router {
  const router = Router();
  const stateFetcher = createRunStateFetcher({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
  const spendFetcher = createRunSpendFetcher({
    apiKey: opts.apiKey,
    baseUrl: opts.coreBaseUrl,
    fetchImpl: opts.fetchImpl,
  });
  const transactionsFetcher = createRunTransactionsFetcher({
    apiKey: opts.apiKey,
    baseUrl: opts.coreBaseUrl,
    fetchImpl: opts.fetchImpl,
  });

  /**
   * GET /api/runs/:executionId/state
   *
   * Returns a {@link RunView} for the given execution id. The harness fetches
   * the execution projection from the agents surface (key stays server-side)
   * and maps it through decodeExecutionProjection → renderRunState before
   * responding. Designed for polling by the web canvas.
   *
   * 200  RunView JSON — execution found and decoded
   * 400  executionId missing or empty
   * 404  execution not found on the agents surface
   * 502  upstream error or decode failure
   * 503  harness is not signed in to Sapiom
   */
  router.get("/api/runs/:executionId/state", async (req, res) => {
    const id = req.params.executionId;
    if (!id || typeof id !== "string" || id.trim() === "") {
      res.status(400).json({ error: "executionId is required" });
      return;
    }

    const result = await stateFetcher.fetch(id);
    if (result.ok) {
      res.json(result.runView);
    } else {
      res.status(result.status).json({ error: result.error });
    }
  });

  /**
   * GET /api/runs/:executionId/spend
   *
   * Returns a {@link RunSpend} for the given execution id, fetched from the
   * core surface (api.sapiom.ai). Cost settles just after a run finishes, so
   * the SPA polls this endpoint a few extra times after terminal state. The key
   * stays server-side and never reaches the browser.
   *
   * 200  RunSpend JSON — spend found and decoded
   * 400  executionId missing or empty
   * 404  spend not found on the core surface
   * 502  upstream error or decode failure
   * 503  harness is not signed in to Sapiom
   */
  router.get("/api/runs/:executionId/spend", async (req, res) => {
    const id = req.params.executionId;
    if (!id || typeof id !== "string" || id.trim() === "") {
      res.status(400).json({ error: "executionId is required" });
      return;
    }

    const result = await spendFetcher.fetch(id);
    if (result.ok) {
      res.json(result.spend);
    } else {
      res.status(result.status).json({ error: result.error });
    }
  });

  /**
   * GET /api/runs/:executionId/transactions
   *
   * Returns the per-call cost drill-down ({@link RunCall}[]) for the given
   * execution — the individual billable capability calls behind each step's
   * cost, so the canvas can answer "why is this step costly". Provider-agnostic
   * (capability labels only) and key-safe (fetched server-side).
   *
   * 200  RunCall[] JSON — transactions found and mapped
   * 400  executionId missing or empty
   * 404  transactions not found on the core surface
   * 502  upstream error or decode failure
   * 503  harness is not signed in to Sapiom
   */
  router.get("/api/runs/:executionId/transactions", async (req, res) => {
    const id = req.params.executionId;
    if (!id || typeof id !== "string" || id.trim() === "") {
      res.status(400).json({ error: "executionId is required" });
      return;
    }

    const result = await transactionsFetcher.fetch(id);
    if (result.ok) {
      res.json(result.calls);
    } else {
      res.status(result.status).json({ error: result.error });
    }
  });

  return router;
}
