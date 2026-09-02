import type {
  AcceptedProposalDelta,
  AgentMapWorkspaceResponse,
  StudioProjectId,
} from "@shared/agent-map";

import { applyAcceptedProposalDelta } from "./agent-map-projector";

export interface AgentMapSource {
  getAgentMapWorkspace(
    projectId: StudioProjectId,
  ): Promise<AgentMapWorkspaceResponse>;
}

export type AgentMapDeltaOutcome =
  | { status: "applied"; snapshot: AgentMapWorkspaceResponse }
  | { status: "ignored" }
  | { status: "queued" }
  | { status: "needs-refetch" };

export interface AgentMapLoader {
  load(
    source: AgentMapSource,
    projectId: StudioProjectId,
  ): Promise<AgentMapWorkspaceResponse>;
  accept(delta: AcceptedProposalDelta): AgentMapDeltaOutcome;
  /** True only when this exact snapshot was produced by replaying the queued
   * announcement locally. A durable recovery GET is deliberately false. */
  includesQueuedProjection(
    snapshot: AgentMapWorkspaceResponse,
    delta: AcceptedProposalDelta,
  ): boolean;
  invalidate(projectId: StudioProjectId): void;
  retain(projectIds: ReadonlySet<StudioProjectId>): void;
  peek(projectId: StudioProjectId): AgentMapWorkspaceResponse | null;
}

/** Project-keyed, disposable projection cache with stale-response guards. */
export function createAgentMapLoader(): AgentMapLoader {
  const generations = new Map<StudioProjectId, number>();
  const snapshots = new Map<StudioProjectId, AgentMapWorkspaceResponse>();
  const requests = new Map<
    StudioProjectId,
    { generation: number; promise: Promise<AgentMapWorkspaceResponse> }
  >();
  const queued = new Map<StudioProjectId, AcceptedProposalDelta[]>();
  const queuedProjections = new WeakMap<
    AgentMapWorkspaceResponse,
    ReadonlySet<string>
  >();

  const deltaKey = (delta: AcceptedProposalDelta): string =>
    `${delta.proposalId}:${delta.version}:${delta.operationIds.join(",")}`;

  const generationFor = (projectId: StudioProjectId): number =>
    generations.get(projectId) ?? 0;

  const load = (
    source: AgentMapSource,
    projectId: StudioProjectId,
  ): Promise<AgentMapWorkspaceResponse> => {
    const generation = generationFor(projectId);
    const current = requests.get(projectId);
    if (current?.generation === generation) return current.promise;
    const cached = snapshots.get(projectId);
    if (cached) return Promise.resolve(cached);

    let promise!: Promise<AgentMapWorkspaceResponse>;
    promise = source.getAgentMapWorkspace(projectId).then((read) => {
      if (read.project.projectId !== projectId)
        throw new Error("Invalid Agent Map response");
      if (generationFor(projectId) !== generation) {
        if (requests.get(projectId)?.promise === promise)
          requests.delete(projectId);
        return load(source, projectId);
      }
      // retain() may retire this project while its read is still in flight.
      // Let the original caller settle, but never resurrect the evicted cache.
      if (requests.get(projectId)?.promise !== promise) return read;
      let next = read;
      const appliedQueuedDeltas = new Set<string>();
      const pending = queued.get(projectId) ?? [];
      queued.delete(projectId);
      for (const delta of pending) {
        const proposal = next.proposal;
        if (
          proposal &&
          proposal.id === delta.proposalId &&
          delta.version <= proposal.version
        )
          continue;
        const projected = applyAcceptedProposalDelta(next, delta);
        if (projected.status !== "applied") {
          generations.set(projectId, generation + 1);
          snapshots.delete(projectId);
          requests.delete(projectId);
          return load(source, projectId);
        }
        next = projected.snapshot;
        appliedQueuedDeltas.add(deltaKey(delta));
      }
      if (appliedQueuedDeltas.size > 0)
        queuedProjections.set(next, appliedQueuedDeltas);
      snapshots.set(projectId, next);
      return next;
    });
    requests.set(projectId, { generation, promise });
    void promise.finally(() => {
      if (requests.get(projectId)?.promise === promise)
        requests.delete(projectId);
    });
    return promise;
  };

  return {
    load,
    accept(delta) {
      const projectId = delta.projectId;
      const snapshot = snapshots.get(projectId);
      // Queuing is only useful while an initial/refetch request can consume
      // the announcement. A never-opened project gets a fresh durable GET when
      // selected, without retaining an event-only cache entry indefinitely.
      if (!snapshot && !requests.has(projectId))
        return { status: "needs-refetch" };
      if (!snapshot || requests.has(projectId)) {
        const pending = queued.get(projectId) ?? [];
        if (
          !pending.some(
            (candidate) =>
              candidate.proposalId === delta.proposalId &&
              candidate.version === delta.version,
          )
        )
          pending.push(delta);
        queued.set(projectId, pending);
        return { status: "queued" };
      }
      if (
        snapshot.proposal?.id === delta.proposalId &&
        delta.version <= snapshot.proposal.version
      )
        return { status: "ignored" };
      const result = applyAcceptedProposalDelta(snapshot, delta);
      if (result.status === "ignored") return { status: "ignored" };
      if (result.status === "needs-refetch") {
        this.invalidate(projectId);
        return { status: "needs-refetch" };
      }
      snapshots.set(projectId, result.snapshot);
      return { status: "applied", snapshot: result.snapshot };
    },
    includesQueuedProjection(snapshot, delta) {
      return queuedProjections.get(snapshot)?.has(deltaKey(delta)) ?? false;
    },
    invalidate(projectId) {
      generations.set(projectId, generationFor(projectId) + 1);
      snapshots.delete(projectId);
      requests.delete(projectId);
      queued.delete(projectId);
    },
    retain(projectIds) {
      for (const projectId of new Set([
        ...generations.keys(),
        ...snapshots.keys(),
        ...requests.keys(),
        ...queued.keys(),
      ])) {
        if (projectIds.has(projectId)) continue;
        snapshots.delete(projectId);
        requests.delete(projectId);
        queued.delete(projectId);
      }
    },
    peek(projectId) {
      return snapshots.get(projectId) ?? null;
    },
  };
}

export const agentMapLoader = createAgentMapLoader();
