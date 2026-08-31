import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import type {
  WorkspaceScope,
  WorkspaceScopeResolver,
} from "../core/system-graph.js";
import type { SystemGraphStore } from "../core/system-graph-store.js";
import {
  SYSTEM_GRAPH_CACHE_HEADER,
  type SystemGraphCacheStatus,
  type SystemGraphNavigationResponse,
  type SystemGraphSnapshot,
} from "../shared/system-graph.js";

export interface SystemGraphRouterOptions {
  scopeResolver: WorkspaceScopeResolver;
  store: SystemGraphStore;
  onScopeAccess?: (scope: WorkspaceScope) => void | Promise<void>;
  /** Re-run registry prerequisites before an explicit user retry. */
  onScopeRefresh?: (
    scope: WorkspaceScope,
  ) => SystemGraphSnapshot | Promise<SystemGraphSnapshot>;
}

/** Mounted beneath the boot-token-protected `/api` boundary. */
export function createSystemGraphRouter(
  options: SystemGraphRouterOptions,
): Router {
  const router = Router();
  const route = "/workspaces/:workspaceKey/system-graph";

  const serve = async (
    req: Request,
    res: Response,
    next: NextFunction,
    refresh: boolean,
  ): Promise<void> => {
    try {
      const scope = await options.scopeResolver.resolve(
        req.params.workspaceKey,
      );
      if (!scope) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
      try {
        await options.onScopeAccess?.(scope);
      } catch {
        // Watcher setup is best-effort. A graph read must remain available
        // even when automatic freshness cannot be armed.
      }
      await (refresh
        ? (options.onScopeRefresh?.(scope) ?? options.store.refresh(scope))
        : options.store.get(scope));
      const snapshot = options.store.peek(scope.workspaceKey);
      if (!snapshot) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
      const cacheStatus: SystemGraphCacheStatus =
        snapshot.state === "ready" ? "complete" : "degraded";
      res.set(SYSTEM_GRAPH_CACHE_HEADER, cacheStatus).json(snapshot);
    } catch (err) {
      next(err);
    }
  };

  router.get(route, (req, res, next) => {
    void serve(req, res, next, false);
  });
  router.post(`${route}/refresh`, (req, res, next) => {
    void serve(req, res, next, true);
  });

  router.get(`${route}/navigation`, async (req, res, next) => {
    try {
      const scope = await options.scopeResolver.resolve(
        req.params.workspaceKey,
      );
      if (!scope) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
      try {
        await options.onScopeAccess?.(scope);
      } catch {
        // Resolver reads remain available when freshness watching cannot arm.
      }
      await options.store.ensureInitialized(scope);
      if (!options.store.peek(scope.workspaceKey)) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
      const navigation = options.store.peekNavigation(scope.workspaceKey);
      if (!navigation) {
        res.status(404).json({ error: "System graph not found" });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(navigation satisfies SystemGraphNavigationResponse);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
