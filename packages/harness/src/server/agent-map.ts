import { Router } from "express";
import { z } from "zod";

import {
  type AgentMapErrorCode,
  type AgentMapErrorResponse,
  type AgentMapWorkspaceResponse,
  type StudioWorkspaceSelection,
} from "../shared/agent-map.js";
import type { WorkflowInfo } from "../shared/types.js";
import type { WorkspaceScopeSummary } from "../shared/system-graph.js";
import {
  AgentMapWorkspaceStore,
  AgentMapWorkspaceStoreError,
} from "../core/agent-map-workspace-store.js";
import {
  StudioProjectCatalog,
  StudioProjectCatalogError,
} from "../core/studio-project-catalog.js";
import { canonicalGraphPath } from "../core/canonical-graph-path.js";
import {
  StudioWorkspacePreferenceStore,
  StudioWorkspacePreferenceStoreError,
} from "../core/studio-workspace-preferences.js";

export interface AgentMapRouterOptions {
  catalog: StudioProjectCatalog;
  store: AgentMapWorkspaceStore;
  preferences: StudioWorkspacePreferenceStore;
  /** Current trusted principal; authentication can change without a restart. */
  currentUserId: () => string;
  listWorkflows: () =>
    | readonly WorkflowInfo[]
    | Promise<readonly WorkflowInfo[]>;
  isWorkflowScanComplete: (
    roots: readonly string[],
  ) => boolean | Promise<boolean>;
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

const rootAssociationSchema = z.object({ root: z.string().min(1) }).strict();
const createProjectSchema = z
  .object({ displayName: z.string().min(1) })
  .strict();
const studioProjectIdSchema = z
  .string()
  .regex(
    /^project_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const studioAgentIdSchema = z
  .string()
  .regex(
    /^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const putCurrentWorkspaceSchema = z
  .object({
    selection: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("agent-map"),
          projectId: studioProjectIdSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("agent"),
          projectId: studioProjectIdSchema,
          agentId: studioAgentIdSchema,
        })
        .strict(),
    ]),
  })
  .strict();

async function allowlistedScope(
  options: AgentMapRouterOptions,
  requestedRoot: string,
): Promise<WorkspaceScopeSummary | null> {
  let requested: string;
  try {
    requested = canonicalGraphPath(requestedRoot);
  } catch {
    return null;
  }
  for (const scope of await options.listWorkspaceScopes()) {
    try {
      if (canonicalGraphPath(scope.cwd) === requested) return scope;
    } catch {
      // One malformed live scope cannot authorize or poison another root.
    }
  }
  return null;
}

/** Mounted beneath the boot-token-protected `/api` boundary. */
export function createAgentMapRouter(options: AgentMapRouterOptions): Router {
  const router = Router();

  router.post("/projects", async (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorBody("malformed_state"));
      return;
    }
    try {
      const project = await options.catalog.create(parsed.data.displayName);
      res.status(201).setHeader("Cache-Control", "no-store").json(project);
    } catch (error) {
      const bounded =
        error instanceof StudioProjectCatalogError
          ? error.code
          : "storage_unavailable";
      res
        .status(bounded === "storage_unavailable" ? 503 : 400)
        .json(errorBody(bounded));
    }
  });

  // These two mutations are the trusted project-open association boundary.
  // The boot-token-authenticated client names an existing durable project and
  // a root already allow-listed by Studio. The catalog, not a path/hash/model,
  // owns whether that root moves an existing binding or adds another one.
  router.post("/projects/:projectId/root-bindings", async (req, res) => {
    const parsed = rootAssociationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorBody("malformed_state"));
      return;
    }
    try {
      const project = await options.catalog.resolve(req.params.projectId);
      if (!project) {
        res.status(404).json(errorBody("project_not_found"));
        return;
      }
      const scope = await allowlistedScope(options, parsed.data.root);
      if (!scope) {
        res.status(404).json(errorBody("project_not_found"));
        return;
      }
      const updated = await options.catalog.addRootBinding(
        project.projectId,
        scope.cwd,
        { legacyWorkspaceKey: scope.workspaceKey },
      );
      res.status(201).setHeader("Cache-Control", "no-store").json(updated);
    } catch (error) {
      const bounded =
        error instanceof StudioProjectCatalogError
          ? error.code
          : "storage_unavailable";
      res
        .status(bounded === "storage_unavailable" ? 503 : 400)
        .json(errorBody(bounded));
    }
  });

  router.put(
    "/projects/:projectId/root-bindings/:bindingId",
    async (req, res) => {
      const parsed = rootAssociationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(errorBody("malformed_state"));
        return;
      }
      try {
        const project = await options.catalog.resolve(req.params.projectId);
        if (!project) {
          res.status(404).json(errorBody("project_not_found"));
          return;
        }
        const scope = await allowlistedScope(options, parsed.data.root);
        if (!scope) {
          res.status(404).json(errorBody("project_not_found"));
          return;
        }
        const updated = await options.catalog.moveRootBinding(
          project.projectId,
          req.params.bindingId,
          scope.cwd,
          scope.workspaceKey,
        );
        res.status(200).setHeader("Cache-Control", "no-store").json(updated);
      } catch (error) {
        const bounded =
          error instanceof StudioProjectCatalogError
            ? error.code
            : "storage_unavailable";
        res
          .status(bounded === "storage_unavailable" ? 503 : 400)
          .json(errorBody(bounded));
      }
    },
  );
  const projectContext = async (projectId: string) => {
    const reconciled = await options.catalog.reconcile(
      await options.listWorkspaceScopes(),
    );
    const project = await options.catalog.resolve(projectId);
    if (!project) return null;
    return {
      project,
      roots: reconciled.workspaceScopes
        .filter((scope) => scope.projectId === project.projectId)
        .map((scope) => scope.cwd),
    };
  };
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
      const { workspace, proposal } = await options.store.readSnapshot(
        project.projectId,
      );
      res
        .status(200)
        .setHeader("Cache-Control", "no-store")
        .json({
          schemaVersion: 1,
          project,
          workspace,
          proposal,
        } satisfies AgentMapWorkspaceResponse);
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

  router.get("/projects/:projectId/current-workspace", async (req, res) => {
    try {
      const context = await projectContext(req.params.projectId);
      if (!context) {
        res.status(404).json(errorBody("project_not_found"));
        return;
      }
      const current = await options.preferences.current(
        options.currentUserId(),
        context.project.projectId,
        context.roots,
        await options.listWorkflows(),
        await options.isWorkflowScanComplete(context.roots),
      );
      res.status(200).setHeader("Cache-Control", "no-store").json(current);
    } catch (error) {
      const bounded =
        error instanceof StudioWorkspacePreferenceStoreError ||
        error instanceof StudioProjectCatalogError
          ? error.code
          : "storage_unavailable";
      res
        .status(bounded === "storage_unavailable" ? 503 : 500)
        .json(errorBody(bounded));
    }
  });

  router.put("/projects/:projectId/current-workspace", async (req, res) => {
    try {
      const context = await projectContext(req.params.projectId);
      if (!context) {
        res.status(404).json(errorBody("project_not_found"));
        return;
      }
      const parsed = putCurrentWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(errorBody("malformed_state"));
        return;
      }
      const selection: StudioWorkspaceSelection = parsed.data.selection;
      const current = await options.preferences.put(
        options.currentUserId(),
        context.project.projectId,
        selection,
        context.roots,
        await options.listWorkflows(),
        await options.isWorkflowScanComplete(context.roots),
      );
      res.status(200).setHeader("Cache-Control", "no-store").json(current);
    } catch (error) {
      const bounded =
        error instanceof StudioWorkspacePreferenceStoreError ||
        error instanceof StudioProjectCatalogError
          ? error.code
          : "storage_unavailable";
      res
        .status(bounded === "storage_unavailable" ? 503 : 500)
        .json(errorBody(bounded));
    }
  });

  // SAP-3143: Studio no longer creates planner sessions. A project session is
  // an ordinary session (POST /api/sessions with the project root as cwd) that
  // also has the Agent Map tools. A stale client that still calls the planner
  // routes gets a reason, not a 404 it would mistake for a missing project.
  router.all("/projects/:projectId/planner-sessions*", (_req, res) => {
    res.status(410).json({
      code: "planner_sessions_removed",
      error:
        "Planner sessions were removed. Start an ordinary session in the project root; it has the Agent Map tools.",
    });
  });
  return router;
}
