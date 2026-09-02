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
      let next = read;
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
      }
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
        generations.delete(projectId);
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
