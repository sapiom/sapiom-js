import { Router } from "express";

import {
  type AgentMapErrorCode,
  type AgentMapErrorResponse,
  type AgentMapWorkspaceResponse,
} from "../shared/agent-map.js";
import type { WorkspaceScopeSummary } from "../shared/system-graph.js";
import {
  AgentMapWorkspaceStore,
  AgentMapWorkspaceStoreError,
} from "../core/agent-map-workspace-store.js";
import {
  StudioProjectCatalog,
  StudioProjectCatalogError,
} from "../core/studio-project-catalog.js";

export interface AgentMapRouterOptions {
  catalog: StudioProjectCatalog;
  store: AgentMapWorkspaceStore;
  /** Existing allow-listed roots only; this callback must not scan source. */
  listWorkspaceScopes: () =>
    | readonly WorkspaceScopeSummary[]
    | Promise<readonly WorkspaceScopeSummary[]>;
}

const ERROR_MESSAGES: Record<AgentMapErrorCode, string> = {
  project_not_found: "Studio project not found",
  malformed_state: "Agent Map state is malformed",
  unsupported_schema: "Agent Map state uses an unsupported schema",
  storage_unavailable: "Agent Map storage is unavailable",
};

function errorBody(code: AgentMapErrorCode): AgentMapErrorResponse {
  return { code, error: ERROR_MESSAGES[code] };
}

/** Mounted beneath the boot-token-protected `/api` boundary. */
export function createAgentMapRouter(options: AgentMapRouterOptions): Router {
  const router = Router();
  router.get("/projects/:projectId/agent-map/workspace", async (req, res) => {
    try {
      await options.catalog.reconcile(await options.listWorkspaceScopes());
      const project = await options.catalog.resolve(req.params.projectId);
      if (!project) {
        res.status(404).json(errorBody("project_not_found"));
        return;
      }

      // Project resolution intentionally happens before the lazy initializer:
      // an arbitrary/cross-instance ID can never create a state directory.
      const workspace = await options.store.readOrCreate(project.projectId);
      res
        .status(200)
        .setHeader("Cache-Control", "no-store")
        .json({ project, workspace } satisfies AgentMapWorkspaceResponse);
    } catch (error) {
      const bounded =
        error instanceof AgentMapWorkspaceStoreError ||
        error instanceof StudioProjectCatalogError
          ? error.code
          : "storage_unavailable";
      res
        .status(bounded === "storage_unavailable" ? 503 : 500)
        .json(errorBody(bounded));
    }
  });
  return router;
}
