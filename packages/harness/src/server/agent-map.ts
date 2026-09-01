import { Router } from "express";
import { z } from "zod";

import {
  type AgentMapErrorCode,
  type AgentMapErrorResponse,
  type AgentMapWorkspaceResponse,
  type PlannerMessageRequest,
  type PlannerSessionRequest,
} from "../shared/agent-map.js";
import { SPAWNABLE_HARNESS_KINDS } from "../shared/types.js";
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
  PlanningSessionError,
  type PlanningSessionService,
} from "../core/planning-session.js";
import {
  PlannerDispatchForbiddenError,
  PlannerGreetingRetryUnavailableError,
  type PlannerGreetingCoordinator,
} from "../core/planner-greeting.js";

export interface AgentMapRouterOptions {
  catalog: StudioProjectCatalog;
  store: AgentMapWorkspaceStore;
  /** Existing allow-listed roots only; this callback must not scan source. */
  listWorkspaceScopes: () =>
    | readonly WorkspaceScopeSummary[]
    | Promise<readonly WorkspaceScopeSummary[]>;
  planningSessions?: PlanningSessionService;
  plannerGreeting?: PlannerGreetingCoordinator;
}

const plannerSessionSchema = z
  .object({
    mode: z.enum(["resume-or-create", "fresh"]),
    harness: z.enum(SPAWNABLE_HARNESS_KINDS).optional(),
    theme: z.enum(["light", "dark"]).optional(),
  })
  .strict() satisfies z.ZodType<PlannerSessionRequest>;

const plannerMessageSchema = z
  .object({ text: z.string().min(1).max(100_000) })
  .strict() satisfies z.ZodType<PlannerMessageRequest>;

function sendPlanningError(
  res: import("express").Response,
  error: unknown,
): boolean {
  if (error instanceof PlannerDispatchForbiddenError) {
    res.status(403).json({ code: error.code, error: error.message });
    return true;
  }
  if (!(error instanceof PlanningSessionError)) return false;
  const status =
    error.code === "project_not_found" || error.code === "session_not_found"
      ? 404
      : error.code === "forbidden"
        ? 403
        : 409;
  res.status(status).json({ code: error.code, error: error.message });
  return true;
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

  router.post("/projects/:projectId/planner-sessions", async (req, res, next) => {
    if (!options.planningSessions || !options.plannerGreeting) {
      res.status(501).json({ error: "Planner sessions are unavailable" });
      return;
    }
    const parsed = plannerSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid planner session request" });
      return;
    }
    try {
      await options.catalog.reconcile(await options.listWorkspaceScopes());
      const result = await options.planningSessions.open(
        req.params.projectId,
        parsed.data,
      );
      res.status(result.resolution === "created" ? 201 : 200).json(result);
    } catch (error) {
      if (!sendPlanningError(res, error)) next(error);
    }
  });

  router.post(
    "/projects/:projectId/planner-sessions/:sessionId/messages",
    async (req, res, next) => {
      if (!options.planningSessions || !options.plannerGreeting) {
        res.status(501).json({ error: "Planner sessions are unavailable" });
        return;
      }
      const parsed = plannerMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid planner message" });
        return;
      }
      try {
        await options.planningSessions.requireOwned(
          req.params.projectId,
          req.params.sessionId,
        );
        const metadata = await options.plannerGreeting.enqueue(
          req.params.sessionId,
          parsed.data.text,
        );
        res.status(202).json({ metadata });
      } catch (error) {
        if (!sendPlanningError(res, error)) next(error);
      }
    },
  );

  router.post(
    "/projects/:projectId/planner-sessions/:sessionId/greeting/retry",
    async (req, res, next) => {
      if (!options.planningSessions || !options.plannerGreeting) {
        res.status(501).json({ error: "Planner sessions are unavailable" });
        return;
      }
      if (Object.keys((req.body ?? {}) as object).length > 0) {
        res.status(400).json({ error: "Invalid greeting retry request" });
        return;
      }
      try {
        const session = await options.planningSessions.requireOwned(
          req.params.projectId,
          req.params.sessionId,
        );
        await options.plannerGreeting.retry(req.params.sessionId);
        res.status(202).json({
          metadata: session.planning,
        });
      } catch (error) {
        if (error instanceof PlannerGreetingRetryUnavailableError) {
          res.status(409).json({ code: error.code, error: error.message });
        } else if (!sendPlanningError(res, error)) next(error);
      }
    },
  );
  return router;
}
