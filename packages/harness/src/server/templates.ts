/**
 * Templates router — backs GET /api/templates and GET /api/templates/:id.
 *
 * Relays the Sapiom core gallery (the same catalog the dashboard's Template
 * library renders) to the SPA. The API key is held server-side and never
 * forwarded to the browser — the router fetches on the dialog's behalf via
 * {@link createTemplateCatalog}, exactly as the runs router does for live run
 * state. That is also why this can't be a direct browser fetch of core: the
 * `sk_…` key would have to reach the page, and core sends no CORS headers for
 * the harness's origin.
 */

import { Router } from "express";

import { createTemplateCatalog } from "../core/template-catalog.js";
import { type ApiKeyProvider } from "../core/api-key-provider.js";

export interface TemplatesRouterOpts {
  /** The Sapiom API key (`sk_…`), NOT the local boot token. Pass a provider so a
   *  rejected key can refresh + retry instead of locking the gallery. */
  apiKey: string | null | ApiKeyProvider;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam. */
  fetchImpl?: typeof fetch;
}

export function createTemplatesRouter(opts: TemplatesRouterOpts): Router {
  const router = Router();
  const catalog = createTemplateCatalog({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });

  /**
   * GET /api/templates
   *
   * 200 always — a `TemplateListResponse`. Deliberately never an error status:
   * an unreachable or signed-out catalog is a degraded gallery (the bundled
   * starters remain available), not a failed request, and core's own endpoint
   * makes the same choice. `source`/`reason` carry the degradation so the dialog
   * can explain itself.
   */
  router.get("/api/templates", async (_req, res) => {
    res.json(await catalog.list());
  });

  /**
   * GET /api/templates/:id
   *
   * 200  TemplateDetailView
   * 404  unknown id, or the catalog could not be reached
   */
  router.get("/api/templates/:id", async (req, res) => {
    const id = req.params.id;
    if (!id || id.trim() === "") {
      res.status(400).json({ error: "template id is required" });
      return;
    }
    const detail = await catalog.detail(id);
    if (!detail) {
      res.status(404).json({ error: `Template not found: ${id}` });
      return;
    }
    res.json(detail);
  });

  return router;
}
