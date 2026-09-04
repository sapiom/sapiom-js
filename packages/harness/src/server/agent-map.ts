import { Router } from "express";
import { z } from "zod";

import {
  type AgentMapErrorCode,
  type AgentMapErrorResponse,
  type AgentMapWorkspaceResponse,
  type PlannerMessageRequest,
  type PlannerSessionRequest,
  type StudioProjectSummary,
  type StudioWorkspaceSelection,
} from "../shared/agent-map.js";
import { SPAWNABLE_HARNESS_KINDS, type WorkflowInfo } from "../shared/types.js";
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
import {
  ProjectSessionError,
  type ProjectSessionService,
} from "../core/planning-session.js";
import { ProjectSessionScopeUnavailableError } from "../core/session-manager.js";
import {
  ProjectBootstrapDispatchForbiddenError,
  ProjectBootstrapRetryUnavailableError,
  projectBootstrapOwnsInput,
  type ProjectBootstrapCoordinator,
} from "../core/planner-greeting.js";

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
  projectSessions?: ProjectSessionService;
  projectBootstrap?: ProjectBootstrapCoordinator;
  /** New-project lifecycle hooks; never called by Agent Map reads. */
  onProjectCreated?: (project: StudioProjectSummary) => Promise<void> | void;
  onRootBound?: (
    project: StudioProjectSummary,
    root: string,
  ) => Promise<void> | void;
  /** Neutral ordinary-session input boundary used by rolling aliases. */
  submitSessionInput?: (sessionId: string, text: string) => Promise<boolean>;
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

function sendProjectSessionError(
  res: import("express").Response,
  error: unknown,
): boolean {
  if (error instanceof ProjectBootstrapDispatchForbiddenError) {
    res.status(403).json({ code: error.code, error: error.message });
    return true;
  }
  if (error instanceof ProjectSessionScopeUnavailableError) {
    res.status(409).json({ code: error.code, error: error.message });
    return true;
  }
  if (!(error instanceof ProjectSessionError)) return false;
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
    try {
      await options.onProjectCreated?.(project);
      res.status(201).setHeader("Cache-Control", "no-store").json(project);
    } catch {
      // The catalog commit already won. Report that stable identity instead of
      // a 503 that invites a non-idempotent retry and creates a second project;
      // lifecycle scheduling is project-keyed and may converge on root bind or
      // startup recovery.
      res
        .status(202)
        .setHeader("Cache-Control", "no-store")
        .setHeader("X-Sapiom-Project-Initialization", "pending")
        .json(project);
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
    let updated: StudioProjectSummary;
    let root: string;
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
      root = scope.cwd;
      updated = await options.catalog.addRootBinding(project.projectId, root, {
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
    try {
      await options.onRootBound?.(updated, root);
      res.status(201).setHeader("Cache-Control", "no-store").json(updated);
    } catch {
      // The binding commit is already durable and idempotent. Preserve its
      // stable identity while telling the client only that lifecycle work is
      // pending; retrying this same association cannot append another binding.
      res
        .status(202)
        .setHeader("Cache-Control", "no-store")
        .setHeader("X-Sapiom-Project-Initialization", "pending")
        .json(updated);
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
      let updated: StudioProjectSummary;
      let root: string;
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
        root = scope.cwd;
        updated = await options.catalog.moveRootBinding(
          project.projectId,
          req.params.bindingId,
          root,
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
      try {
        await options.onRootBound?.(updated, root);
        res.status(200).setHeader("Cache-Control", "no-store").json(updated);
      } catch {
        res
          .status(202)
          .setHeader("Cache-Control", "no-store")
          .setHeader("X-Sapiom-Project-Initialization", "pending")
          .json(updated);
      }
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
  router.get("/projects/:projectId/agent-map/workspace", async (req, res) => {
    try {
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

  /** @deprecated Rolling alias to ordinary project-session open; remove in SAP-3152. */
  router.post(
    "/projects/:projectId/planner-sessions",
    async (req, res, next) => {
      if (!options.projectSessions) {
        res.status(501).json({ error: "Project sessions are unavailable" });
        return;
      }
      const parsed = plannerSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid planner session request" });
        return;
      }
      try {
        const result = await options.projectSessions.open(
          req.params.projectId,
          parsed.data,
        );
        res.status(result.resolution === "created" ? 201 : 200).json(result);
      } catch (error) {
        if (!sendProjectSessionError(res, error)) next(error);
      }
    },
  );

  /** @deprecated Rolling alias to ordinary project-session input; remove in SAP-3152. */
  router.post(
    "/projects/:projectId/planner-sessions/:sessionId/messages",
    async (req, res, next) => {
      if (!options.projectSessions || !options.submitSessionInput) {
        res.status(501).json({ error: "Project sessions are unavailable" });
        return;
      }
      const parsed = plannerMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid planner message" });
        return;
      }
      try {
        const session = await options.projectSessions.requireOwned(
          req.params.projectId,
          req.params.sessionId,
        );
        if (
          options.projectBootstrap &&
          projectBootstrapOwnsInput(session.projectBootstrap)
        ) {
          await options.projectBootstrap.enqueue(
            req.params.sessionId,
            parsed.data.text,
          );
        } else if (
          !(await options.submitSessionInput(
            req.params.sessionId,
            parsed.data.text,
          ))
        ) {
          res
            .status(404)
            .json({ error: "Project session has no live process" });
          return;
        }
        res.status(202).json({ metadata: session.projectBootstrap ?? null });
      } catch (error) {
        if (!sendProjectSessionError(res, error)) next(error);
      }
    },
  );

  /** @deprecated Rolling alias; remove after persisted clients migrate in SAP-3152. */
  router.post(
    "/projects/:projectId/planner-sessions/:sessionId/greeting/retry",
    async (req, res, next) => {
      if (!options.projectSessions || !options.projectBootstrap) {
        res.status(501).json({ error: "Project bootstrap is unavailable" });
        return;
      }
      if (Object.keys((req.body ?? {}) as object).length > 0) {
        res.status(400).json({ error: "Invalid greeting retry request" });
        return;
      }
      try {
        const session = await options.projectSessions.requireOwned(
          req.params.projectId,
          req.params.sessionId,
        );
        if (!session.projectBootstrap) {
          throw new ProjectBootstrapRetryUnavailableError();
        }
        await options.projectBootstrap.retry(req.params.sessionId);
        res.status(202).json({
          metadata: session.projectBootstrap,
        });
      } catch (error) {
        if (error instanceof ProjectBootstrapRetryUnavailableError) {
          res.status(409).json({ code: error.code, error: error.message });
        } else if (!sendProjectSessionError(res, error)) next(error);
      }
    },
  );
  return router;
}
