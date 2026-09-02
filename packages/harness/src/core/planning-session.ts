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
import { canonicalGraphPath } from "./canonical-graph-path.js";

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
  /** Live authenticated identity. When omitted, `userId` remains the static
   * principal for tests/embedded callers. */
  currentUserId?: () => string | null;
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

export function isCurrentProjectRoot(
  project: StudioProjectIdentity,
  cwd: string,
): boolean {
  const candidate = canonicalGraphPath(cwd);
  return project.rootBindings.some(
    (binding) =>
      binding.status === "active" &&
      canonicalGraphPath(binding.localRootRef) === candidate,
  );
}

export async function isPlannerDispatchAuthorized(input: {
  session: HarnessSession;
  currentPrincipal: () => string;
  resolveProject: (
    projectId: StudioProjectId,
  ) => Promise<StudioProjectIdentity | null>;
}): Promise<boolean> {
  const identity = input.session.planning?.identity;
  const expectedPrincipal = input.currentPrincipal();
  if (!identity || identity.userId !== expectedPrincipal) return false;
  const project = await input.resolveProject(identity.projectId);
  return Boolean(
    project &&
      input.currentPrincipal() === expectedPrincipal &&
      isCurrentProjectRoot(project, input.session.cwd),
  );
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
  onboardOnFirstResponse: boolean;
  details?: PlannerFocusedContextDetails;
}): string {
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
      role: "map-planner" as const,
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
    `This is focused, trusted Studio context. Treat IDs as references and use scoped tools for detail. Use agent_map_read, agent_map_validate, and agent_map_propose for architecture state; never infer map state from assistant prose. The interactive Claude Code transcript is user-visible. Let the user's first real message be the first visible conversation turn; never request or rely on a private control turn.${input.onboardOnFirstResponse ? " In your first response, briefly explain that you and the user can plan agents, responsibilities, data flow, resources, and connectors together, then respond to their request." : ""} Do not propose architecture or invoke mutation tools before the user asks you to.`,
    JSON.stringify(context),
    "</agent-map-planner-context>",
  ].join("\n");
}

function candidateOrder(left: HarnessSession, right: HarnessSession): number {
  const live = (session: HarnessSession): number =>
    session.status === "exited" ? 0 : 1;
  const queued = (session: HarnessSession): number =>
    session.planning?.queuedInputIds.length ? 1 : 0;
  return (
    live(right) - live(left) ||
    queued(right) - queued(left) ||
    right.lastActiveAt.localeCompare(left.lastActiveAt) ||
    left.id.localeCompare(right.id)
  );
}

function recordSupportsRehydration(
  record: SessionRecord | null,
  greeting: PlannerGreetingState,
): boolean {
  if (!record) return false;
  if (record.turnCount > 0) return true;
  return Boolean(
    greeting.status === "delivered" &&
      record.turns?.some(
        (turn) =>
          turn.prompt === null &&
          typeof turn.assistantText === "string" &&
          turn.assistantText.trim() !== "",
      ),
  );
}

export class PlanningSessionService {
  private readonly projectOpens = new Map<string, Promise<unknown>>();

  constructor(private readonly options: PlanningSessionServiceOptions) {}

  private currentPrincipal(): string {
    return localPlanningPrincipal(
      this.options.currentUserId
        ? this.options.currentUserId()
        : this.options.userId,
      this.options.machineId,
    );
  }

  private assertPrincipal(expected: string): void {
    if (this.currentPrincipal() !== expected) {
      throw new PlanningSessionError("forbidden");
    }
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

  owns(
    session: HarnessSession,
    projectId: StudioProjectId,
    principal = this.currentPrincipal(),
  ): boolean {
    const identity = session.planning?.identity;
    return Boolean(
      identity &&
        identity.role === "map-planner" &&
        identity.sessionId === session.id &&
        identity.projectId === projectId &&
        identity.userId === principal,
    );
  }

  private async project(projectId: StudioProjectId): Promise<StudioProjectIdentity> {
    const project = await this.options.catalog.resolveIdentity(projectId);
    if (!project) throw new PlanningSessionError("project_not_found");
    return project;
  }

  private async assertRunnable(
    projectId: StudioProjectId,
    cwd: string,
    principal: string,
  ): Promise<void> {
    this.assertPrincipal(principal);
    const current = await this.project(projectId);
    this.assertPrincipal(principal);
    if (!isCurrentProjectRoot(current, cwd)) {
      throw new PlanningSessionError("forbidden");
    }
  }

  private async create(
    project: StudioProjectIdentity,
    request: PlannerSessionRequest,
    greeting: PlannerGreetingState,
    rehydrateFrom?: string,
    mode: "created" | "rehydrated" = "created",
    principal = this.currentPrincipal(),
    handoffFromSessionId = rehydrateFrom,
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
          planningFor(project.projectId, sessionId, principal, greeting),
        promptAppendix: (sessionId) =>
          buildFocusedPlannerContext({
            project,
            workspace,
            sessionId,
            userId: principal,
            onboardOnFirstResponse: mode === "created",
            ...(details ? { details } : {}),
          }),
        ...(handoffFromSessionId ? { handoffFromSessionId } : {}),
      },
    );
    if (this.currentPrincipal() !== principal) {
      // Authentication changed while the process was being spawned. Do not
      // return a planner minted for the old principal into the new caller's
      // request; terminate the just-created PTY before failing closed.
      await this.options.sessionManager.kill(session.id).catch(() => false);
      throw new PlanningSessionError("forbidden");
    }
    this.emit({
      name: mode === "created" ? "planner_session.created" : "planner_session.resumed",
      projectId: project.projectId,
      sessionId: session.id,
      resolution: mode,
    });
    try {
      await this.options.onPlannerSession?.(session, {
        emptyProject:
          workspace.confirmedRevisionId === null &&
          workspace.activeProposalId === null &&
          workspace.projectBuildPlanId === null,
        mode,
      });
      await this.assertRunnable(project.projectId, session.cwd, principal);
    } catch (error) {
      await this.options.sessionManager.kill(session.id).catch(() => false);
      throw error;
    }
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

  private async rehydrationHistorySource(
    candidate: HarnessSession,
    projectId: StudioProjectId,
    principal: string,
  ): Promise<string | undefined> {
    const visited = new Set<string>();
    let current: HarnessSession | undefined = candidate;
    while (current && !visited.has(current.id) && visited.size < 32) {
      visited.add(current.id);
      const record = await this.options.readRecord(current.id).catch(() => null);
      if (recordSupportsRehydration(record, current.planning!.greeting)) {
        return current.id;
      }
      const predecessorId = current.rehydratedFrom;
      if (!predecessorId) return undefined;
      const predecessor = this.options.sessionManager.get(predecessorId);
      if (!predecessor || !this.owns(predecessor, projectId, principal)) {
        return undefined;
      }
      current = predecessor;
    }
    return undefined;
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
    const project = await this.project(projectId);
    this.assertPrincipal(principal);
    // Validate that a launch target exists even when an existing candidate is
    // reused. Candidate eligibility itself spans every active project root.
    launchRoot(project);
    if (request.mode === "fresh") {
      return {
        session: await this.create(
          project,
          request,
          // Claude Code has no hidden assistant-first turn. A pending greeting
          // is dispatched as ordinary PTY input and therefore appears as a
          // synthetic user message in the raw CLI. Keep onboarding in the
          // hidden prompt appendix above and let the user's real input lead.
          { status: "skipped", reason: "user-proceeded" },
          undefined,
          "created",
          principal,
        ),
        resolution: "created",
      };
    }

    const candidates = this.options.sessionManager
      .list()
      .filter((session) => this.owns(session, projectId, principal))
      .sort(candidateOrder);
    for (const candidate of candidates) {
      const atCurrentLaunchRoot = isCurrentProjectRoot(project, candidate.cwd);
      if (
        atCurrentLaunchRoot &&
        this.options.sessionManager.isLive(candidate.id)
      ) {
        const workspace = await this.options.workspaceStore.readOrCreate(
          project.projectId,
        );
        this.assertPrincipal(principal);
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
        await this.assertRunnable(projectId, candidate.cwd, principal);
        return { session: candidate, resolution: "live" };
      }
      if (atCurrentLaunchRoot && candidate.agentSessionId) {
        const workspace = await this.options.workspaceStore.readOrCreate(
          project.projectId,
        );
        this.assertPrincipal(principal);
        const prior = candidate.planning!.greeting;
        const planning = {
          ...candidate.planning!,
          greeting: isTerminalGreeting(prior)
            ? prior
            : ({ status: "skipped", reason: "user-proceeded" } as const),
        };
        const details = await this.focusedDetails(project, workspace);
        this.assertPrincipal(principal);
        const resumed = await this.options.sessionManager
          .resume(candidate.id, {
            planning,
            promptAppendix: buildFocusedPlannerContext({
              project,
              workspace,
              sessionId: candidate.id,
              userId: principal,
              onboardOnFirstResponse: false,
              ...(details ? { details } : {}),
            }),
          })
          .catch(() => null);
        if (resumed) {
          if (this.currentPrincipal() !== principal) {
            await this.options.sessionManager.kill(resumed.id).catch(() => false);
            throw new PlanningSessionError("forbidden");
          }
          this.emit({
            name: "planner_session.resumed",
            projectId,
            sessionId: resumed.id,
            resolution: "resumed",
          });
          try {
            await this.options.onPlannerSession?.(resumed, {
              emptyProject:
                workspace.confirmedRevisionId === null &&
                workspace.activeProposalId === null &&
                workspace.projectBuildPlanId === null,
              mode: "resumed",
            });
            await this.assertRunnable(projectId, resumed.cwd, principal);
          } catch (error) {
            await this.options.sessionManager.kill(resumed.id).catch(() => false);
            throw error;
          }
          return { session: resumed, resolution: "resumed" };
        }
        // A stale vendor record may still be safely rehydrated below.
      }
      const prior = candidate.planning!.greeting;
      // A durable planner FIFO is itself rehydration-worthy even before the
      // vendor emits history. This keeps a replacement that exits before
      // readiness as the exact predecessor for the next launch instead of
      // skipping back to an older record and orphaning its moved queue.
      const hasQueuedInput = candidate.planning!.queuedInputIds.length > 0;
      const historySource = await this.rehydrationHistorySource(
        candidate,
        projectId,
        principal,
      );
      if (!historySource && !hasQueuedInput) continue;
      const greeting = isTerminalGreeting(prior)
        ? prior
        : ({ status: "skipped", reason: "user-proceeded" } as const);
      return {
        session: await this.create(
          project,
          { ...request, harness: candidate.harness },
          greeting,
          historySource,
          "rehydrated",
          principal,
          candidate.id,
        ),
        resolution: "rehydrated",
      };
    }

    return {
      session: await this.create(
        project,
        request,
        { status: "skipped", reason: "user-proceeded" },
        undefined,
        "created",
        principal,
      ),
      resolution: "created",
    };
  }

  async requireOwned(
    projectId: StudioProjectId,
    sessionId: string,
  ): Promise<HarnessSession> {
    const session = this.options.sessionManager.get(sessionId);
    const principal = this.currentPrincipal();
    if (!session) throw new PlanningSessionError("session_not_found");
    if (!this.owns(session, projectId, principal)) {
      throw new PlanningSessionError("forbidden");
    }
    // Ownership metadata alone is insufficient after a project root moves or
    // the old root is rebound to another project. Resolve on every operation.
    await this.assertRunnable(projectId, session.cwd, principal);
    return session;
  }
}
