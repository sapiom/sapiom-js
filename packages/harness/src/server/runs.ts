/**
 * Runs router — backs GET /api/runs/:executionId/state.
 *
 * Returns a {@link RunView} (live status) for a running or finished prod agents
 * execution, so the web canvas can poll live status. The Sapiom API key is held
 * server-side and never forwarded to the browser — the router fetches on behalf
 * of the canvas via {@link createRunStateFetcher}.
 */

import { Router } from "express";

import { createRunStateFetcher } from "../core/run-state.js";

export interface RunsRouterOpts {
  /** Sapiom API key for the agents surface; null when the harness is not authenticated. */
  apiKey: string | null;
  /** Override the agents base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /**
   * Injectable fetch implementation forwarded to the fetcher. Undocumented for
   * prod — exists as a test seam only, mirroring the pattern used elsewhere in
   * the harness resolver suite.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Create the runs router. Mounts `GET /api/runs/:executionId/state`, delegating
 * to the run-state fetcher for the upstream call.
 */
export function createRunsRouter(opts: RunsRouterOpts): Router {
  const router = Router();
  const stateFetcher = createRunStateFetcher({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
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

  return router;
}
