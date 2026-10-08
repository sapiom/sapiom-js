import { Router } from "express";
import { z } from "zod";
import {
  type AgentMapErrorCode,
  type AgentMapErrorResponse,
  type StudioProjectSummary,
  type StudioWorkspaceSelection,
} from "@sapiom/agent-map";
import type { WorkflowInfo } from "../shared/types.js";
import type { WorkspaceScopeInput } from "../shared/workspace-scope.js";
import { samePath } from "@sapiom/agent-map/paths";
import {
  StudioProjectCatalog,
  StudioProjectCatalogError,
} from "@sapiom/agent-map/node/studio-project-catalog";
import { canonicalGraphPath } from "@sapiom/agent-map/node/canonical-graph-path";
import {
  StudioWorkspacePreferenceStore,
  StudioWorkspacePreferenceStoreError,
} from "../core/studio-workspace-preferences.js";

export interface StudioProjectsRouterOptions {
  catalog: StudioProjectCatalog;
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
    | readonly WorkspaceScopeInput[]
    | Promise<readonly WorkspaceScopeInput[]>;
}

const ERROR_MESSAGES: Record<AgentMapErrorCode, string> = {
  project_not_found: "Studio project not found",
  malformed_state: "Studio project state is malformed",
  unsupported_schema: "Studio project state uses an unsupported schema",
  storage_unavailable: "Studio project storage is unavailable",
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
  options: StudioProjectsRouterOptions,
  requestedRoot: string,
): Promise<WorkspaceScopeInput | null> {
  let requested: string;
  try {
    requested = canonicalGraphPath(requestedRoot);
  } catch {
    return null;
  }
  for (const scope of await options.listWorkspaceScopes()) {
    try {
      if (samePath(canonicalGraphPath(scope.cwd), requested)) return scope;
    } catch {
      // One malformed live scope cannot authorize or poison another root.
    }
  }
  return null;
}

/**
 * Studio project identity: create a project, bind its roots, and read or set
 * the current workspace. Mounted beneath the boot-token-protected `/api`
 * boundary. The agent map has its own route (project-map.ts).
 */
export function createStudioProjectsRouter(options: StudioProjectsRouterOptions): Router {
  const router = Router();

  router.post("/projects", async (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorBody("malformed_state"));
      return;
    }
    let project: StudioProjectSummary;
    try {
      project = await options.catalog.create(parsed.data.displayName);
    } catch (error) {
      const bounded =
        error instanceof StudioProjectCatalogError
          ? error.code
          : "storage_unavailable";
      res
        .status(bounded === "storage_unavailable" ? 503 : 400)
        .json(errorBody(bounded));
      return;
    }
    res.status(201).setHeader("Cache-Control", "no-store").json(project);
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
    let updated: StudioProjectSummary;
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
      updated = await options.catalog.addRootBinding(project.projectId, scope.cwd, {
        legacyWorkspaceKey: scope.workspaceKey,
      });
    } catch (error) {
      const bounded =
        error instanceof StudioProjectCatalogError
          ? error.code
          : "storage_unavailable";
      res
        .status(bounded === "storage_unavailable" ? 503 : 400)
        .json(errorBody(bounded));
      return;
    }
    res.status(201).setHeader("Cache-Control", "no-store").json(updated);
  });

  router.put(
    "/projects/:projectId/root-bindings/:bindingId",
    async (req, res) => {
      const parsed = rootAssociationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(errorBody("malformed_state"));
        return;
      }
      let updated: StudioProjectSummary;
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
        updated = await options.catalog.moveRootBinding(
          project.projectId,
          req.params.bindingId,
          scope.cwd,
          scope.workspaceKey,
        );
      } catch (error) {
        const bounded =
          error instanceof StudioProjectCatalogError
            ? error.code
            : "storage_unavailable";
        res
          .status(bounded === "storage_unavailable" ? 503 : 400)
          .json(errorBody(bounded));
        return;
      }
      res.status(200).setHeader("Cache-Control", "no-store").json(updated);
    },
  );
  const projectContext = async (projectId: string) => {
    const project = await options.catalog.resolve(projectId);
    if (!project) return null;
    const identity = await options.catalog.resolveIdentity(project.projectId);
    if (!identity) return null;
    return {
      project,
      roots: identity.rootBindings
        .filter((binding) => binding.status === "active")
        .map((binding) => binding.localRootRef),
    };
  };
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

  return router;
}
