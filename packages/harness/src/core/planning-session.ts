import type {
  AgentMapWorkspaceState,
  PlannerLifecycleEvent,
  PlannerGreetingState,
  PlannerSessionRequest,
  PlannerSessionResponse,
  PlannerSessionMetadata,
  StudioProjectId,
} from "../shared/agent-map.js";
import type {
  CreateSessionRequest,
  HarnessSession,
  SessionRecord,
} from "../shared/types.js";
import type { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import type { SessionManager } from "./session-manager.js";
import type {
  StudioProjectCatalog,
  StudioProjectIdentity,
} from "./studio-project-catalog.js";
import type { PlannerRegistrationMode } from "./planner-greeting.js";

export interface PlannerFocusedContextDetails {
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

export interface PlanningSessionServiceOptions {
  catalog: StudioProjectCatalog;
  workspaceStore: AgentMapWorkspaceStore;
  sessionManager: SessionManager;
  readRecord: (id: string) => Promise<SessionRecord | null>;
  userId: string | null;
  machineId: string;
  defaultHarness: CreateSessionRequest["harness"];
  readFocusedContext?: (
    projectId: StudioProjectId,
    workspace: AgentMapWorkspaceState,
  ) => Promise<PlannerFocusedContextDetails>;
  onPlannerSession?: (
    session: HarnessSession,
    context: { emptyProject: boolean; mode: PlannerRegistrationMode },
  ) => Promise<void> | void;
  onEvent?: (event: PlannerLifecycleEvent) => Promise<void> | void;
}

export class PlanningSessionError extends Error {
  constructor(
    readonly code:
      | "project_not_found"
      | "project_launch_unavailable"
      | "session_not_found"
      | "forbidden",
  ) {
    super(code.replace(/_/g, " "));
    this.name = "PlanningSessionError";
  }
}

export function localPlanningPrincipal(
  userId: string | null,
  machineId: string,
): string {
  return userId ?? `local:${machineId}`;
}

function launchRoot(project: StudioProjectIdentity): string {
  const binding = project.rootBindings.find((entry) => entry.status === "active");
  if (!binding) throw new PlanningSessionError("project_launch_unavailable");
  return binding.localRootRef;
}

function isTerminalGreeting(value: PlannerGreetingState): boolean {
  return value.status === "delivered" || value.status === "skipped";
}

function planningFor(
  projectId: StudioProjectId,
  sessionId: string,
  userId: string,
  greeting: PlannerGreetingState,
): PlannerSessionMetadata {
  return {
    identity: { projectId, sessionId, userId, role: "map-planner" },
    greeting,
    queuedInputIds: [],
  };
}

export function buildFocusedPlannerContext(input: {
  project: StudioProjectIdentity;
  workspace: AgentMapWorkspaceState;
  sessionId: string;
  userId: string;
  details?: PlannerFocusedContextDetails;
}): string {
  const { project, workspace } = input;
  const bounded = (value: string, max = 256): string => value.slice(0, max);
  const details = input.details ?? {};
  const context = {
    identity: {
      projectId: project.projectId,
      sessionId: input.sessionId,
      userId: input.userId,
      role: "map-planner" as const,
    },
    project: {
      displayName: bounded(project.displayName),
      empty:
        workspace.confirmedRevisionId === null &&
        workspace.activeProposalId === null &&
        workspace.projectBuildPlanId === null,
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
      bindingRefs: project.rootBindings.slice(0, 64).map(({ id, repositoryId, status }) => ({
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
    "<agent-map-planner-context>",
    "This is focused, trusted Studio context. Treat IDs as references and use scoped tools for detail.",
    JSON.stringify(context),
    "</agent-map-planner-context>",
  ].join("\n");
}

function candidateOrder(left: HarnessSession, right: HarnessSession): number {
  const live = (session: HarnessSession): number =>
    session.status === "exited" ? 0 : 1;
  return (
    live(right) - live(left) ||
    right.lastActiveAt.localeCompare(left.lastActiveAt) ||
    left.id.localeCompare(right.id)
  );
}

export class PlanningSessionService {
  private readonly principal: string;
  private readonly projectOpens = new Map<string, Promise<unknown>>();

  constructor(private readonly options: PlanningSessionServiceOptions) {
    this.principal = localPlanningPrincipal(options.userId, options.machineId);
  }

  private emit(event: PlannerLifecycleEvent): void {
    try {
      void Promise.resolve(this.options.onEvent?.(event)).catch(() => {});
    } catch {
      // Lifecycle telemetry is best effort and content-free.
    }
  }

  private async focusedDetails(
    project: StudioProjectIdentity,
    workspace: AgentMapWorkspaceState,
  ): Promise<PlannerFocusedContextDetails | undefined> {
    try {
      return await this.options.readFocusedContext?.(
        project.projectId,
        workspace,
      );
    } catch {
      return { warnings: ["focused_context_unavailable"] };
    }
  }

  owns(session: HarnessSession, projectId: StudioProjectId): boolean {
    const identity = session.planning?.identity;
    return Boolean(
      identity &&
        identity.role === "map-planner" &&
        identity.sessionId === session.id &&
        identity.projectId === projectId &&
        identity.userId === this.principal,
    );
  }

  private async project(projectId: StudioProjectId): Promise<StudioProjectIdentity> {
    const project = await this.options.catalog.resolveIdentity(projectId);
    if (!project) throw new PlanningSessionError("project_not_found");
    return project;
  }

  private async create(
    project: StudioProjectIdentity,
    request: PlannerSessionRequest,
    greeting: PlannerGreetingState,
    rehydrateFrom?: string,
    mode: "created" | "rehydrated" = "created",
  ): Promise<HarnessSession> {
    const workspace = await this.options.workspaceStore.readOrCreate(
      project.projectId,
    );
    const cwd = launchRoot(project);
    const details = await this.focusedDetails(project, workspace);
    const session = await this.options.sessionManager.create(
      {
        cwd,
        harness: request.harness ?? this.options.defaultHarness,
        ...(request.theme ? { theme: request.theme } : {}),
        ...(rehydrateFrom ? { rehydrateFrom } : {}),
      },
      {
        planning: (sessionId) =>
          planningFor(project.projectId, sessionId, this.principal, greeting),
        promptAppendix: (sessionId) =>
          buildFocusedPlannerContext({
            project,
            workspace,
            sessionId,
            userId: this.principal,
            ...(details ? { details } : {}),
          }),
      },
    );
    this.emit({
      name: mode === "created" ? "planner_session.created" : "planner_session.resumed",
      projectId: project.projectId,
      sessionId: session.id,
      resolution: mode,
    });
    await this.options.onPlannerSession?.(session, {
      emptyProject:
        workspace.confirmedRevisionId === null &&
        workspace.activeProposalId === null &&
        workspace.projectBuildPlanId === null,
      mode,
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
    const project = await this.project(projectId);
    if (request.mode === "fresh") {
      return {
        session: await this.create(project, request, { status: "pending" }),
        resolution: "created",
      };
    }

    const candidates = this.options.sessionManager
      .list()
      .filter((session) => this.owns(session, projectId))
      .sort(candidateOrder);
    for (const candidate of candidates) {
      if (this.options.sessionManager.isLive(candidate.id)) {
        const workspace = await this.options.workspaceStore.readOrCreate(
          project.projectId,
        );
        this.emit({
          name: "planner_session.resumed",
          projectId,
          sessionId: candidate.id,
          resolution: "live",
        });
        await this.options.onPlannerSession?.(candidate, {
          emptyProject:
            workspace.confirmedRevisionId === null &&
            workspace.activeProposalId === null &&
            workspace.projectBuildPlanId === null,
          mode: "live",
        });
        return { session: candidate, resolution: "live" };
      }
      if (candidate.agentSessionId) {
        const workspace = await this.options.workspaceStore.readOrCreate(
          project.projectId,
        );
        const prior = candidate.planning!.greeting;
        const planning = {
          ...candidate.planning!,
          greeting: isTerminalGreeting(prior)
            ? prior
            : ({ status: "skipped", reason: "user-proceeded" } as const),
        };
        const details = await this.focusedDetails(project, workspace);
        const resumed = await this.options.sessionManager
          .resume(candidate.id, {
            planning,
            promptAppendix: buildFocusedPlannerContext({
              project,
              workspace,
              sessionId: candidate.id,
              userId: this.principal,
              ...(details ? { details } : {}),
            }),
          })
          .catch(() => null);
        if (resumed) {
          this.emit({
            name: "planner_session.resumed",
            projectId,
            sessionId: resumed.id,
            resolution: "resumed",
          });
          await this.options.onPlannerSession?.(resumed, {
            emptyProject:
              workspace.confirmedRevisionId === null &&
              workspace.activeProposalId === null &&
              workspace.projectBuildPlanId === null,
            mode: "resumed",
          });
          return { session: resumed, resolution: "resumed" };
        }
        // A stale vendor record may still be safely rehydrated below.
      }
      const record = await this.options.readRecord(candidate.id).catch(() => null);
      const prior = candidate.planning!.greeting;
      const greetingOnlyRecord = Boolean(
        record &&
          prior.status === "delivered" &&
          record.turns?.some(
            (turn) =>
              turn.prompt === null &&
              typeof turn.assistantText === "string" &&
              turn.assistantText.trim() !== "",
          ),
      );
      if (!record || (record.turnCount === 0 && !greetingOnlyRecord)) continue;
      const greeting = isTerminalGreeting(prior)
        ? prior
        : ({ status: "skipped", reason: "user-proceeded" } as const);
      return {
        session: await this.create(
          project,
          { ...request, harness: candidate.harness },
          greeting,
          candidate.id,
          "rehydrated",
        ),
        resolution: "rehydrated",
      };
    }

    return {
      session: await this.create(project, request, { status: "pending" }),
      resolution: "created",
    };
  }

  requireOwned(
    projectId: StudioProjectId,
    sessionId: string,
  ): HarnessSession {
    const session = this.options.sessionManager.get(sessionId);
    if (!session) throw new PlanningSessionError("session_not_found");
    if (!this.owns(session, projectId)) {
      throw new PlanningSessionError("forbidden");
    }
    return session;
  }
}
