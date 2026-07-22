/**
 * Op-status router — backs GET /api/agents/:definitionId/op-status.
 *
 * Returns the per-agent {@link OperationalStatus} — the four stitched
 * operational signals (runs+failing, scheduled, deployment, open alerts) the
 * Studio rail + focused health strip render for triage. The Sapiom API key is
 * held server-side and never forwarded to the browser: the router fetches on
 * behalf of the SPA via {@link createOpStatusFetcher}, exactly as the runs
 * router does for run-state/spend/transactions.
 *
 * The optional `?slug=` query lets the caller pass the slug the rail already
 * carries so the fetcher can fan out all four signals in parallel; omit it and
 * the fetcher recovers the slug from the definition detail (id-space bridge).
 */

import { Router } from "express";

import { createOpStatusFetcher } from "../core/op-status.js";

export interface OpStatusRouterOpts {
  /** Sapiom API key for the core surface; null when the harness is not authenticated. */
  apiKey: string | null;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /**
   * Injectable fetch implementation forwarded to the fetcher. Undocumented for
   * prod — exists as a test seam only, mirroring the pattern used elsewhere in
   * the harness resolver suite.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Create the op-status router. Mounts
 * `GET /api/agents/:definitionId/op-status`, delegating to the fetcher which
 * fans out to the four upstream signals and stitches them.
 */
export function createOpStatusRouter(opts: OpStatusRouterOpts): Router {
  const router = Router();
  const fetcher = createOpStatusFetcher({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });

  /**
   * GET /api/agents/:definitionId/op-status
   *
   * Returns an {@link OperationalStatus} for the given definition id. Optional
   * `?slug=` supplies the triggers key up front (else recovered from detail).
   * Individual signal failures fold to honest absence within a 200 body — only
   * a bad request or missing credentials produce a non-200.
   *
   * 200  OperationalStatus JSON — request well-formed and authenticated
   *      (any/all signals may be absent if their upstream call failed)
   * 400  definitionId missing or empty
   * 503  harness is not signed in to Sapiom
   */
  router.get("/api/agents/:definitionId/op-status", async (req, res) => {
    const definitionId = req.params.definitionId;
    if (
      !definitionId ||
      typeof definitionId !== "string" ||
      definitionId.trim() === ""
    ) {
      res.status(400).json({ error: "definitionId is required" });
      return;
    }

    // A single repeated `?slug=` yields a string; anything else (array from a
    // duplicated param, object) is ignored — the fetcher then resolves the slug
    // from the definition detail.
    const rawSlug = req.query.slug;
    const slug = typeof rawSlug === "string" && rawSlug !== "" ? rawSlug : null;

    const result = await fetcher.fetch({ definitionId, slug });
    if (result.ok) {
      res.json(result.status);
    } else {
      res.status(result.status).json({ error: result.error });
    }
  });

  return router;
}
