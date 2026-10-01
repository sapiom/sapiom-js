/**
 * App Link router — backs GET /api/workflows/:id/app-link, the session bar's
 * durable-link chip beside the localhost Preview (SAP-3255).
 *
 * The API key is held server-side and the read goes through
 * {@link createDefinitionAppLinkReader}, for the same reasons as account.ts:
 * the `sk_…` key must not reach the page, and core sends no CORS headers for
 * the harness's origin.
 *
 * WHY THE ID IS A PATH. As in secrets.ts: the SPA addresses an agent by its
 * project directory, and the cloud definition id is read from that project's
 * `sapiom.json` at request time rather than taken from the caller, so the page
 * cannot ask for another definition's link through this route.
 */

import { Router } from "express";
import { readConfig as coreReadConfig } from "@sapiom/agent-core";

import { type ApiKeyProvider } from "../core/api-key-provider.js";
import {
  NO_APP_LINK,
  createDefinitionAppLinkReader,
  type DefinitionAppLinkReader,
} from "../core/definition-app-link.js";

export interface AppLinkRouterOpts {
  /** The Sapiom API key (`sk_…`), NOT the local boot token. */
  apiKey: string | null | ApiKeyProvider;
  /** Resolve a registered agent's project directory from the route id. */
  resolveWorkflow: (id: string) => { path: string } | null;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam. */
  fetchImpl?: typeof fetch;
  /** Injectable reader. Test seam; defaults to the real one. */
  reader?: DefinitionAppLinkReader;
  /** Injectable `sapiom.json` read. Test seam. */
  readConfig?: typeof coreReadConfig;
}

export function createAppLinkRouter(opts: AppLinkRouterOpts): Router {
  const router = Router();
  const reader =
    opts.reader ??
    createDefinitionAppLinkReader({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
    });
  const readConfig = opts.readConfig ?? coreReadConfig;

  /**
   * GET /api/workflows/:id/app-link
   *
   * 200 with a `DefinitionAppLinkView` for any known agent. An unlinked agent,
   * an unreadable `sapiom.json`, and a failed core read all answer
   * `{ url: null, status: null }`: the chip is ambient, and "no App Link" is
   * what the bar shows for every one of them.
   * 404 when the id names no registered agent.
   */
  router.get("/api/workflows/:id/app-link", async (req, res) => {
    const workflow = opts.resolveWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    let definitionId: string | null = null;
    try {
      const config = readConfig(workflow.path);
      definitionId = config?.definitionId ? String(config.definitionId) : null;
    } catch {
      definitionId = null;
    }
    res.json(definitionId ? await reader.read(definitionId) : NO_APP_LINK);
  });

  return router;
}
