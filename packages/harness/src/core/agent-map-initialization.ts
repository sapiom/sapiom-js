import { randomUUID } from "node:crypto";
import type { HarnessKind } from "../shared/types.js";
import type {
  AgentMapInitializationError,
  AgentMapInitializationStatus,
} from "../shared/agent-map-initialization.js";
import {
  AgentMapWorkspaceStore,
  AgentMapWorkspaceStoreError,
} from "./agent-map-workspace-store.js";
import {
  AgentMapProposalConflictError,
  AgentMapProposalQuotaError,
  AgentMapProposalService,
  AgentMapProposalValidationError,
} from "./agent-map-proposal-service.js";
import {
  AgentMapInitializationFailure,
  hasAuthoredAgentMap,
  initializationStatus,
  type AgentMapInitializationTransaction,
  type AgentMapInitializationRecord,
} from "./agent-map-initialization-record.js";
import {
  collectAgentMapEvidence,
  initialMapRequest,
  type InitializationAgent,
} from "./agent-map-initialization-evidence.js";

export { AgentMapInitializationFailure } from "./agent-map-initialization-record.js";
export interface InitializationProject {
  userId: string;
  available: boolean;
  discoveryComplete: boolean;
  agents: InitializationAgent[];
  provider: HarnessKind | null;
}
export interface AgentMapInitializationOptions {
  store: AgentMapWorkspaceStore;
  proposals: AgentMapProposalService;
  project: (projectId: string) => Promise<InitializationProject | null>;
  infer: (input: {
    projectId: string;
    attemptId: string;
    provider: "claude-code" | "codex";
    prompt: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
  onChange?: (status: AgentMapInitializationStatus) => void;
  concurrency?: number;
  timeoutMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** A project owns one automatic attempt. The journal and final map share the normal map write lock. */
export class AgentMapInitializationCoordinator {
  private readonly ownerId = randomUUID();
  private readonly pending = new Set<string>();
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private closed = false;
  private readonly operations = new Set<Promise<unknown>>();
  constructor(private readonly options: AgentMapInitializationOptions) {}

  private eligible(
    project: InitializationProject | null,
  ): project is InitializationProject {
    return (
      !!project?.available &&
      project.discoveryComplete &&
      project.agents.length > 0
    );
  }
  private alive(pid: number): boolean {
    if (this.options.isPidAlive) return this.options.isPidAlive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  private emit(
    projectId: string,
    record: AgentMapInitializationRecord | null,
  ): void {
    try {
      this.options.onChange?.(initializationStatus(projectId, record));
    } catch {
      /* observers cannot affect ownership */
    }
  }

  private async recoverInterrupted(
    projectId: string,
    current: AgentMapInitializationRecord | null,
    journal: AgentMapInitializationTransaction,
  ): Promise<AgentMapInitializationRecord | null> {
    if (current?.status !== "running") return current;
    if (current.ownerId === this.ownerId && this.active.has(projectId))
      return current;
    const abandonedHere =
      current.ownerId === this.ownerId && !this.active.has(projectId);
    if (
      !abandonedHere &&
      current.ownerPid !== null &&
      this.alive(current.ownerPid)
    )
      return current;
    const failed: AgentMapInitializationRecord = {
      ...current,
      status: "failed",
      errorCode: abandonedHere ? "storage_unavailable" : "interrupted",
      ownerId: null,
      ownerPid: null,
      updatedAt: new Date().toISOString(),
    };
    await journal.write(failed);
    this.emit(projectId, failed);
    return failed;
  }

  async status(projectId: string): Promise<AgentMapInitializationStatus> {
    return this.options.store.inspectInitialization(
      projectId,
      async (aggregate, journal) => {
        const record = await journal.read();
        // A real map always takes precedence over stale task state, including crash windows.
        if (hasAuthoredAgentMap(aggregate))
          return {
            projectId,
            status: "completed",
            errorCode: null,
            retryable: false,
          };
        return initializationStatus(
          projectId,
          await this.recoverInterrupted(projectId, record, journal),
        );
      },
    );
  }

  schedule(
    projectId: string,
    retry = false,
  ): Promise<AgentMapInitializationStatus> {
    const operation = this.scheduleProject(projectId, retry);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private async scheduleProject(
    projectId: string,
    retry: boolean,
  ): Promise<AgentMapInitializationStatus> {
    if (this.closed) return initializationStatus(projectId, null);
    const record = await this.options.store.inspectInitialization(
      projectId,
      async (aggregate, journal) => {
        let current = await journal.read();
        const project = await this.options.project(projectId);
        if (this.closed || !project) return current;
        if (current && current.userId !== project.userId)
          throw new AgentMapInitializationFailure("storage_unavailable");
        if (hasAuthoredAgentMap(aggregate)) {
          if (
            current &&
            current.status !== "completed" &&
            current.status !== "skipped"
          ) {
            current = {
              ...current,
              status: "skipped",
              errorCode: null,
              ownerId: null,
              ownerPid: null,
              updatedAt: new Date().toISOString(),
            };
            await journal.write(current);
          }
          return current;
        }
        current = await this.recoverInterrupted(projectId, current, journal);
        if (current?.status === "running") return current;
        if (
          !this.eligible(project) ||
          current?.status === "completed" ||
          current?.status === "skipped"
        )
          return current;
        if (current?.status === "queued") return current;
        if (current && (!retry || current.status !== "failed")) return current;
        current = {
          schemaVersion: 1,
          projectId,
          userId: project.userId,
          attemptId: randomUUID(),
          status: "queued",
          ownerId: null,
          ownerPid: null,
          provider: null,
          errorCode: null,
          updatedAt: new Date().toISOString(),
        };
        await journal.write(current);
        return current;
      },
    );
    this.emit(projectId, record);
    if (record?.status === "queued") {
      this.pending.add(projectId);
      this.pump();
    }
    return initializationStatus(projectId, record);
  }

  /** Ordinary new-project bootstrap takes the same one-time ownership decision.
   * A reservation is permanent: that ordinary coding session owns subsequent map work. */
  reserveForBootstrap(projectId: string): Promise<boolean> {
    const operation = this.reserveBootstrap(projectId);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private async reserveBootstrap(projectId: string): Promise<boolean> {
    if (this.closed) return false;
    return this.options.store.inspectInitialization(
      projectId,
      async (aggregate, journal) => {
        if (hasAuthoredAgentMap(aggregate)) return false;
        const current = await journal.read();
        if (
          current?.status === "queued" ||
          current?.status === "running" ||
          current?.status === "completed"
        )
          return false;
        const project = await this.options.project(projectId);
        if (this.closed || !project?.available) return false;
        await journal.write({
          schemaVersion: 1,
          projectId,
          userId: project.userId,
          attemptId: current?.attemptId ?? randomUUID(),
          status: "skipped",
          ownerId: null,
          ownerPid: null,
          provider: null,
          errorCode: null,
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
    );
  }

  private pump(): void {
    while (!this.closed && this.active.size < (this.options.concurrency ?? 2)) {
      const projectId = [...this.pending].find((id) => !this.active.has(id));
      if (!projectId) break;
      this.pending.delete(projectId);
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() => this.run(projectId, controller))
        .catch(() => {
          // Durable queued/running state remains conservative if storage itself fails.
        })
        .finally(() => {
          this.active.delete(projectId);
          this.pump();
        });
      this.active.set(projectId, { controller, done });
    }
  }

  private async run(
    projectId: string,
    controller: AbortController,
  ): Promise<void> {
    const claimed = await this.options.store.inspectInitialization(
      projectId,
      async (aggregate, journal) => {
        const current = await journal.read();
        if (current?.status !== "queued") return null;
        const project = await this.options.project(projectId);
        if (!this.eligible(project) || project.userId !== current.userId)
          return null;
        if (hasAuthoredAgentMap(aggregate)) {
          const skipped = {
            ...current,
            status: "skipped" as const,
            updatedAt: new Date().toISOString(),
          };
          await journal.write(skipped);
          this.emit(projectId, skipped);
          return null;
        }
        const provider =
          project.provider === "claude-code" || project.provider === "codex"
            ? project.provider
            : null;
        const record: AgentMapInitializationRecord = {
          ...current,
          status: "running",
          ownerId: this.ownerId,
          ownerPid: process.pid,
          provider,
          updatedAt: new Date().toISOString(),
        };
        await journal.write(record);
        return { record, project };
      },
    );
    if (!claimed) return;
    const { record, project } = claimed;
    this.emit(projectId, record);
    const timeout = setTimeout(
      () => controller.abort(new AgentMapInitializationFailure("timeout")),
      this.options.timeoutMs ?? 180_000,
    );
    timeout.unref();
    let status: "completed" | "skipped" | "failed" = "failed";
    let errorCode: AgentMapInitializationError | null = null;
    try {
      if (!record.provider)
        throw new AgentMapInitializationFailure("provider_unavailable");
      controller.signal.throwIfAborted();
      const evidence = await collectAgentMapEvidence(project.agents);
      controller.signal.throwIfAborted();
      const output = await this.options.infer({
        projectId,
        attemptId: record.attemptId,
        provider: record.provider,
        prompt: evidence.prompt,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      const request = initialMapRequest(output, evidence, record.attemptId);
      await this.options.proposals.createInitial(
        {
          projectId,
          userId: record.userId,
          sessionId: `map-initialization-${record.attemptId}`,
        },
        request,
        record.attemptId,
        async () => {
          controller.signal.throwIfAborted();
          if (this.closed) throw new AgentMapInitializationFailure("cancelled");
          const current = await this.options.project(projectId);
          controller.signal.throwIfAborted();
          if (this.closed) throw new AgentMapInitializationFailure("cancelled");
          if (
            !this.eligible(current) ||
            current.userId !== record.userId ||
            current.agents
              .map(({ agentId }) => agentId)
              .sort()
              .join(",") !==
              project.agents
                .map(({ agentId }) => agentId)
                .sort()
                .join(",")
          )
            throw new AgentMapInitializationFailure("evidence_unavailable");
          return true;
        },
      );
      status = "completed";
    } catch (error) {
      if (error instanceof AgentMapProposalConflictError) status = "skipped";
      else
        errorCode =
          error instanceof AgentMapInitializationFailure
            ? error.code
            : error instanceof AgentMapProposalValidationError
              ? "invalid_output"
              : error instanceof AgentMapProposalQuotaError
                ? "limit_exceeded"
                : error instanceof AgentMapWorkspaceStoreError
                  ? "storage_unavailable"
                  : "provider_failed";
    } finally {
      clearTimeout(timeout);
    }
    await this.options.store.inspectInitialization(
      projectId,
      async (aggregate, journal) => {
        const current = await journal.read();
        if (
          current?.status !== "running" ||
          current.attemptId !== record.attemptId ||
          current.ownerId !== this.ownerId
        )
          return;
        if (hasAuthoredAgentMap(aggregate) && status !== "completed") {
          status = "skipped";
          errorCode = null;
        }
        const finished = {
          ...current,
          status,
          errorCode,
          ownerId: null,
          ownerPid: null,
          updatedAt: new Date().toISOString(),
        };
        await journal.write(finished);
        this.emit(projectId, finished);
      },
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pending.clear();
    for (const { controller } of this.active.values())
      controller.abort(new AgentMapInitializationFailure("cancelled"));
    await Promise.allSettled([...this.operations]);
    await Promise.all([...this.active.values()].map(({ done }) => done));
  }
}
