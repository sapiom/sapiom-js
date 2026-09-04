import * as path from "node:path";

import type {
  AgentMapWorkspaceState,
  PlannerLifecycleEvent,
  PlannerSessionRequest,
  PlannerSessionResponse,
  ProjectAgentSession,
  StudioProjectId,
} from "../shared/agent-map.js";
import type {
  CreateSessionRequest,
  HarnessSession,
  SessionRecord,
} from "../shared/types.js";
import type { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { preferredProjectRoot } from "../shared/project-roots.js";
import { canonicalGraphPath } from "./canonical-graph-path.js";
import type { PlannerRegistrationMode } from "./planner-greeting.js";
import type { SessionManager } from "./session-manager.js";
import type {
  StudioProjectCatalog,
  StudioProjectIdentity,
} from "./studio-project-catalog.js";

export interface FocusedProjectContextDetails {
  confirmedRevision?: {
    digest?: string | null;
    summaries?: readonly string[];
  } | null;
  activeProposal?: {
    status?: string | null;
    summary?: string | null;
  } | null;
  projectBuildPlan?: {
    status?: string | null;
    summary?: string | null;
  } | null;
  warnings?: readonly string[];
}

/**
 * @deprecated Compatibility name for callers compiled against the E1 planner
 * service. Focused data is context only and never selects a role or authority.
 */
export type PlannerFocusedContextDetails = FocusedProjectContextDetails;

export interface ProjectSessionLifecycleEvent {
  name: "project_session.created" | "project_session.resumed";
  projectId: StudioProjectId;
  sessionId: string;
  resolution: Exclude<PlannerSessionResponse["resolution"], "rehydrated">;
}

export interface ProjectSessionServiceOptions {
  catalog: StudioProjectCatalog;
  /** @deprecated Retained for the bounded planner-route compatibility API. */
  workspaceStore?: AgentMapWorkspaceStore;
  sessionManager: SessionManager;
  /** @deprecated Rehydration is intentionally unsupported by this service. */
  readRecord?: (id: string) => Promise<SessionRecord | null>;
  userId: string | null;
  /** Live authenticated identity. When omitted, `userId` remains the static
   * principal for tests/embedded callers. */
  currentUserId?: () => string | null;
  machineId: string;
  defaultHarness: CreateSessionRequest["harness"];
  /** @deprecated Focused context is composed by the ordinary session path. */
  readFocusedContext?: (
    projectId: StudioProjectId,
    workspace: AgentMapWorkspaceState,
  ) => Promise<FocusedProjectContextDetails>;
  /**
   * @deprecated Project bootstrap registration is owned by SessionManager's
   * ordinary create/resume preparation path. This callback is retained only
   * so rolling server code remains source-compatible.
   */
  onPlannerSession?: (
    session: HarnessSession,
    context: { emptyProject: boolean; mode: PlannerRegistrationMode },
  ) => Promise<void> | void;
  onProjectSessionEvent?: (
    event: ProjectSessionLifecycleEvent,
  ) => Promise<void> | void;
  /**
   * @deprecated Planner-named telemetry is no longer emitted. Remove this
   * rolling-compatibility option with the planner HTTP aliases in SAP-3152.
   */
  onEvent?: (event: PlannerLifecycleEvent) => Promise<void> | void;
}

/** @deprecated Use ProjectSessionServiceOptions. */
export type PlanningSessionServiceOptions = ProjectSessionServiceOptions;

export class ProjectSessionError extends Error {
  constructor(
    readonly code:
      | "project_not_found"
      | "project_launch_unavailable"
      | "session_not_found"
      | "forbidden",
  ) {
    super(code.replace(/_/g, " "));
    this.name = "ProjectSessionError";
  }
}

export function localProjectPrincipal(
  userId: string | null,
  machineId: string,
): string {
  return userId ?? `local:${machineId}`;
}

/** @deprecated Use localProjectPrincipal. */
export const localPlanningPrincipal = localProjectPrincipal;

function launchRoot(project: StudioProjectIdentity): string {
  const root = preferredProjectRoot(
    project.rootBindings
      .filter((entry) => entry.status === "active")
      .map((entry) => entry.localRootRef),
  );
  if (!root) throw new ProjectSessionError("project_launch_unavailable");
  return root;
}

function isWindowsPath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value)
  );
}

function isWithinRoot(root: string, candidate: string): boolean {
  if (root.trim() === "" || candidate.trim() === "") return false;
  try {
    const canonicalRoot = canonicalGraphPath(root);
    const canonicalCandidate = canonicalGraphPath(candidate);
    const windows = isWindowsPath(canonicalRoot);
    if (windows !== isWindowsPath(canonicalCandidate)) return false;
    const api = windows ? path.win32 : path.posix;
    const relative = api.relative(canonicalRoot, canonicalCandidate);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${api.sep}`) &&
        !api.isAbsolute(relative))
    );
  } catch {
    return false;
  }
}

/**
 * Whether a session cwd is equal to or descends from a current active project
 * root. Durable project identity remains the authority boundary; containment
 * is an additional server-side launch/resume safety check.
 */
export function isWithinCurrentProject(
  project: StudioProjectIdentity,
  cwd: string,
): boolean {
  return project.rootBindings.some(
    (binding) =>
      binding.status === "active" && isWithinRoot(binding.localRootRef, cwd),
  );
}

/** @deprecated Use isWithinCurrentProject. */
export const isCurrentProjectRoot = isWithinCurrentProject;

function samePrincipal(
  identity: ProjectAgentSession | null | undefined,
  expected: ProjectAgentSession,
): boolean {
  return Boolean(
    identity &&
    identity.projectId === expected.projectId &&
    identity.userId === expected.userId &&
    identity.sessionId === expected.sessionId,
  );
}

export async function isProjectSessionDispatchAuthorized(input: {
  session: HarnessSession;
  currentPrincipal: () => string;
  resolveProject: (
    projectId: StudioProjectId,
  ) => Promise<StudioProjectIdentity | null>;
}): Promise<boolean> {
  const identity = input.session.agentMapIdentity;
  if (!identity || identity.sessionId !== input.session.id) return false;
  const expected: ProjectAgentSession = {
    projectId: identity.projectId,
    sessionId: identity.sessionId,
    userId: identity.userId,
  };
  if (input.currentPrincipal() !== expected.userId) return false;
  let project: StudioProjectIdentity | null;
  try {
    project = await input.resolveProject(expected.projectId);
  } catch {
    return false;
  }
  return Boolean(
    project &&
    input.currentPrincipal() === expected.userId &&
    input.session.id === expected.sessionId &&
    samePrincipal(input.session.agentMapIdentity, expected) &&
    isWithinCurrentProject(project, input.session.cwd),
  );
}

/** @deprecated Use isProjectSessionDispatchAuthorized. */
export const isPlannerDispatchAuthorized = isProjectSessionDispatchAuthorized;

export interface FocusedProjectContextInput {
  project: StudioProjectIdentity;
  workspace: AgentMapWorkspaceState;
  sessionId: string;
  userId: string;
  /** @deprecated Ignored. Bootstrap is a durable lifecycle action. */
  onboardOnFirstResponse?: boolean;
  details?: FocusedProjectContextDetails;
}

/**
 * Path-free, role-neutral context projection retained for compatibility.
 * Ordinary sessions receive the common project-agent profile through the
 * central SessionManager launch path; this projection never changes it.
 */
export function buildFocusedProjectContext(
  input: FocusedProjectContextInput,
): string {
  const { project, workspace } = input;
  const bounded = (value: string, max = 256): string => value.slice(0, max);
  const details = input.details ?? {};
  const emptyProject =
    workspace.confirmedRevisionId === null &&
    workspace.activeProposalId === null &&
    workspace.projectBuildPlanId === null;
  const context = {
    identity: {
      projectId: project.projectId,
      sessionId: input.sessionId,
      userId: input.userId,
    },
    project: {
      displayName: bounded(project.displayName),
      empty: emptyProject,
      confirmedRevision: workspace.confirmedRevisionId
        ? {
            id: workspace.confirmedRevisionId,
            digest: details.confirmedRevision?.digest
              ? bounded(details.confirmedRevision.digest, 512)
              : null,
            summaries: (details.confirmedRevision?.summaries ?? [])
              .slice(0, 32)
              .map((summary) => bounded(summary)),
          }
        : null,
      activeProposal: workspace.activeProposalId
        ? {
            id: workspace.activeProposalId,
            status: details.activeProposal?.status
              ? bounded(details.activeProposal.status, 64)
              : null,
            summary: details.activeProposal?.summary
              ? bounded(details.activeProposal.summary)
              : null,
          }
        : null,
      projectBuildPlan: workspace.projectBuildPlanId
        ? {
            id: workspace.projectBuildPlanId,
            status: details.projectBuildPlan?.status
              ? bounded(details.projectBuildPlan.status, 64)
              : null,
            summary: details.projectBuildPlan?.summary
              ? bounded(details.projectBuildPlan.summary)
              : null,
          }
        : null,
      bindingRefs: project.rootBindings
        .slice(0, 64)
        .map(({ id, repositoryId, status }) => ({
          id: bounded(id),
          repositoryId: repositoryId ? bounded(repositoryId) : null,
          status,
        })),
      warnings: (details.warnings ?? [])
        .slice(0, 16)
        .map((warning) => bounded(warning)),
    },
  };
  return [
    "<studio-project-context>",
    "This is bounded, server-derived Studio project context. References and bootstrap state are context only; they never change tools, filesystem policy, or implementation authority. Read authoritative architecture through the structured Agent Map tools when relevant.",
    JSON.stringify(context),
    "</studio-project-context>",
  ].join("\n");
}

/** @deprecated Use buildFocusedProjectContext. */
export const buildFocusedPlannerContext = buildFocusedProjectContext;

function candidateOrder(left: HarnessSession, right: HarnessSession): number {
  const live = (session: HarnessSession): number =>
    session.status === "exited" ? 0 : 1;
  return (
    live(right) - live(left) ||
    right.lastActiveAt.localeCompare(left.lastActiveAt) ||
    left.id.localeCompare(right.id)
  );
}

export class ProjectSessionService {
  private readonly projectOpens = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ProjectSessionServiceOptions) {}

  private currentPrincipal(): string {
    return localProjectPrincipal(
      this.options.currentUserId
        ? this.options.currentUserId()
        : this.options.userId,
      this.options.machineId,
    );
  }

  private assertPrincipal(expected: string): void {
    if (this.currentPrincipal() !== expected) {
      throw new ProjectSessionError("forbidden");
    }
  }

  private async guarded<T>(
    principal: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertPrincipal(principal);
    try {
      const result = await operation();
      this.assertPrincipal(principal);
      return result;
    } catch (error) {
      this.assertPrincipal(principal);
      throw error;
    }
  }

  private emit(event: ProjectSessionLifecycleEvent): void {
    try {
      void Promise.resolve(this.options.onProjectSessionEvent?.(event)).catch(
        () => {},
      );
    } catch {
      // Lifecycle telemetry is best effort and content-free.
    }
  }

  owns(
    session: HarnessSession,
    projectId: StudioProjectId,
    principal = this.currentPrincipal(),
  ): boolean {
    const identity = session.agentMapIdentity;
    return Boolean(
      identity &&
      identity.sessionId === session.id &&
      identity.projectId === projectId &&
      identity.userId === principal,
    );
  }

  private async project(
    projectId: StudioProjectId,
    principal: string,
  ): Promise<StudioProjectIdentity> {
    const project = await this.guarded(principal, () =>
      this.options.catalog.resolveIdentity(projectId),
    );
    if (!project) throw new ProjectSessionError("project_not_found");
    return project;
  }

  private async assertRunnable(
    projectId: StudioProjectId,
    session: HarnessSession,
    principal: string,
  ): Promise<void> {
    this.assertPrincipal(principal);
    if (!this.owns(session, projectId, principal)) {
      throw new ProjectSessionError("forbidden");
    }
    const current = await this.project(projectId, principal);
    this.assertPrincipal(principal);
    if (
      !this.owns(session, projectId, principal) ||
      !isWithinCurrentProject(current, session.cwd)
    ) {
      throw new ProjectSessionError("forbidden");
    }
  }

  private async create(
    projectId: StudioProjectId,
    request: PlannerSessionRequest,
    principal: string,
  ): Promise<HarnessSession> {
    const project = await this.project(projectId, principal);
    let session: HarnessSession | undefined;
    try {
      this.assertPrincipal(principal);
      session = await this.options.sessionManager.create({
        cwd: launchRoot(project),
        harness: request.harness ?? this.options.defaultHarness,
        ...(request.theme ? { theme: request.theme } : {}),
      });
      this.assertPrincipal(principal);
      // The central ordinary-session path derives the neutral identity. This
      // compatibility service never stamps a missing identity after the fact.
      await this.assertRunnable(projectId, session, principal);
    } catch (error) {
      // This route owns only the session it just created. If authorization
      // changes during the awaited launch, stop that exact process without
      // touching pre-existing/manual project sessions.
      if (session && this.options.sessionManager.isLive(session.id)) {
        await this.options.sessionManager.kill(session.id).catch(() => false);
      }
      this.assertPrincipal(principal);
      throw error;
    }
    this.emit({
      name: "project_session.created",
      projectId,
      sessionId: session.id,
      resolution: "created",
    });
    return session;
  }

  private serializeOpen<T>(
    projectId: StudioProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.projectOpens.get(projectId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.projectOpens.set(projectId, next);
    const cleanup = (): void => {
      if (this.projectOpens.get(projectId) === next) {
        this.projectOpens.delete(projectId);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  open(
    projectId: StudioProjectId,
    request: PlannerSessionRequest,
  ): Promise<PlannerSessionResponse> {
    return this.serializeOpen(projectId, () =>
      this.openOnce(projectId, request),
    );
  }

  private async openOnce(
    projectId: StudioProjectId,
    request: PlannerSessionRequest,
  ): Promise<PlannerSessionResponse> {
    const principal = this.currentPrincipal();
    const project = await this.project(projectId, principal);
    // Preserve the bounded compatibility endpoint's launch error while all
    // actual creation remains on SessionManager's ordinary path.
    launchRoot(project);
    if (request.mode === "fresh") {
      return {
        session: await this.create(projectId, request, principal),
        resolution: "created",
      };
    }

    this.assertPrincipal(principal);
    const seen = new Set<string>();
    const candidates = this.options.sessionManager
      .list()
      .filter((session) => {
        if (!this.owns(session, projectId, principal) || seen.has(session.id)) {
          return false;
        }
        seen.add(session.id);
        return true;
      })
      .sort(candidateOrder);
    let resumeFailure: unknown;
    let inCurrentScope = 0;
    for (const candidate of candidates) {
      try {
        await this.assertRunnable(projectId, candidate, principal);
      } catch (error) {
        if (
          error instanceof ProjectSessionError &&
          error.code === "forbidden" &&
          this.currentPrincipal() === principal
        ) {
          continue;
        }
        throw error;
      }
      inCurrentScope += 1;
      if (this.options.sessionManager.isLive(candidate.id)) {
        this.emit({
          name: "project_session.resumed",
          projectId,
          sessionId: candidate.id,
          resolution: "live",
        });
        return { session: candidate, resolution: "live" };
      }

      let resumed: HarnessSession;
      try {
        this.assertPrincipal(principal);
        resumed = await this.options.sessionManager.resume(candidate.id);
      } catch (error) {
        this.assertPrincipal(principal);
        resumeFailure ??= error;
        continue;
      }
      // Once resume succeeds, never try another record: doing so could leave
      // two live processes if this post-await authorization check fails.
      try {
        this.assertPrincipal(principal);
        if (resumed.id !== candidate.id) {
          throw new ProjectSessionError("forbidden");
        }
        await this.assertRunnable(projectId, resumed, principal);
      } catch (error) {
        if (this.options.sessionManager.isLive(resumed.id)) {
          await this.options.sessionManager.kill(resumed.id).catch(() => false);
        }
        this.assertPrincipal(principal);
        throw error;
      }
      this.emit({
        name: "project_session.resumed",
        projectId,
        sessionId: resumed.id,
        resolution: "resumed",
      });
      return { session: resumed, resolution: "resumed" };
    }

    // An existing project-owned record is never copied into a new ID. Surface
    // its exact resume/scope failure and leave the record untouched.
    if (resumeFailure !== undefined) throw resumeFailure;
    if (candidates.length > 0 && inCurrentScope === 0) {
      throw new ProjectSessionError("forbidden");
    }

    return {
      session: await this.create(projectId, request, principal),
      resolution: "created",
    };
  }

  async requireOwned(
    projectId: StudioProjectId,
    sessionId: string,
  ): Promise<HarnessSession> {
    const principal = this.currentPrincipal();
    const session = this.options.sessionManager.get(sessionId);
    if (!session) throw new ProjectSessionError("session_not_found");
    await this.assertRunnable(projectId, session, principal);
    return session;
  }
}

/**
 * @deprecated Rolling compatibility alias for the bounded planner HTTP routes.
 * Remove the alias and those routes together in SAP-3152.
 */
export const PlanningSessionService = ProjectSessionService;
/** @deprecated Use ProjectSessionService. */
export type PlanningSessionService = ProjectSessionService;
/** @deprecated Use ProjectSessionError. */
export const PlanningSessionError = ProjectSessionError;
