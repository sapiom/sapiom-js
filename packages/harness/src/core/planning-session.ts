import type {
  AgentMapWorkspaceState,
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

export interface PlanningSessionServiceOptions {
  catalog: StudioProjectCatalog;
  workspaceStore: AgentMapWorkspaceStore;
  sessionManager: SessionManager;
  readRecord: (id: string) => Promise<SessionRecord | null>;
  userId: string | null;
  machineId: string;
  defaultHarness: CreateSessionRequest["harness"];
  onPlannerSession?: (
    session: HarnessSession,
    context: { emptyProject: boolean },
  ) => Promise<void> | void;
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
}): string {
  const { project, workspace } = input;
  const bounded = (value: string, max = 256): string => value.slice(0, max);
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
      confirmedRevisionId: workspace.confirmedRevisionId,
      activeProposalId: workspace.activeProposalId,
      projectBuildPlanId: workspace.projectBuildPlanId,
      bindingRefs: project.rootBindings.slice(0, 64).map(({ id, repositoryId, status }) => ({
        id: bounded(id),
        repositoryId: repositoryId ? bounded(repositoryId) : null,
        status,
      })),
      warnings: [] as string[],
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

  constructor(private readonly options: PlanningSessionServiceOptions) {
    this.principal = localPlanningPrincipal(options.userId, options.machineId);
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
  ): Promise<HarnessSession> {
    const workspace = await this.options.workspaceStore.readOrCreate(
      project.projectId,
    );
    const cwd = launchRoot(project);
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
          }),
      },
    );
    await this.options.onPlannerSession?.(session, {
      emptyProject:
        workspace.confirmedRevisionId === null &&
        workspace.activeProposalId === null &&
        workspace.projectBuildPlanId === null,
    });
    return session;
  }

  async open(
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
        await this.options.onPlannerSession?.(candidate, { emptyProject: true });
        return { session: candidate, resolution: "live" };
      }
      if (candidate.agentSessionId) {
        try {
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
          const resumed = await this.options.sessionManager.resume(candidate.id, {
            planning,
            promptAppendix: buildFocusedPlannerContext({
              project,
              workspace,
              sessionId: candidate.id,
              userId: this.principal,
            }),
          });
          await this.options.onPlannerSession?.(resumed, { emptyProject: true });
          return { session: resumed, resolution: "resumed" };
        } catch {
          // A stale vendor record may still be safely rehydrated below.
        }
      }
      const record = await this.options.readRecord(candidate.id).catch(() => null);
      if (!record || record.turnCount === 0) continue;
      const prior = candidate.planning!.greeting;
      const greeting = isTerminalGreeting(prior)
        ? prior
        : ({ status: "skipped", reason: "user-proceeded" } as const);
      return {
        session: await this.create(
          project,
          { ...request, harness: candidate.harness },
          greeting,
          candidate.id,
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
