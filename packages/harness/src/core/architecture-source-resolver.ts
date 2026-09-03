import type { AgentMapGraph, StudioProjectId } from "../shared/agent-map.js";
import type {
  AgentMapRevisionId,
  ArchitectureSourceRef,
} from "../shared/build-plan.js";
import { parseArchitectureSourceRef } from "../shared/build-plan-codec.js";
import { materializeAgentMapProposalVersion } from "./agent-map-proposal-service.js";
import { canonicalizeAgentMapGraph } from "./agent-map-proposal-validator.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { computeArchitectureGraphDigest } from "./build-plan-canonicalization.js";

export interface AgentMapRevisionSnapshot {
  projectId: StudioProjectId;
  revisionId: AgentMapRevisionId;
  revisionNumber: number;
  graph: AgentMapGraph;
}

export interface ResolvedArchitectureSource {
  projectId: StudioProjectId;
  source: ArchitectureSourceRef;
  graph: AgentMapGraph;
}

export type ArchitectureSourceResolutionErrorCode =
  | "source_not_found"
  | "source_digest_mismatch"
  | "cross_project";

export class ArchitectureSourceResolutionError extends Error {
  constructor(readonly code: ArchitectureSourceResolutionErrorCode) {
    super(
      code === "source_not_found"
        ? "Architecture source was not found"
        : code === "source_digest_mismatch"
          ? "Architecture source digest does not match"
          : "Architecture source belongs to another project",
    );
    this.name = "ArchitectureSourceResolutionError";
  }
}

/** Exact-only resolver: the API intentionally has no current/latest overload. */
export class ArchitectureSourceResolver {
  constructor(
    private readonly store: AgentMapWorkspaceStore,
    private readonly readRevision: (
      revisionId: AgentMapRevisionId,
    ) => Promise<AgentMapRevisionSnapshot | null> = async () => null,
  ) {}

  async resolve(
    projectId: StudioProjectId,
    input: ArchitectureSourceRef,
  ): Promise<ResolvedArchitectureSource> {
    const source = parseArchitectureSourceRef(input);
    let graph: AgentMapGraph;
    if (source.kind === "revision") {
      const revision = await this.readRevision(source.revisionId);
      if (!revision || revision.revisionNumber !== source.revisionNumber)
        throw new ArchitectureSourceResolutionError("source_not_found");
      if (revision.projectId !== projectId)
        throw new ArchitectureSourceResolutionError("cross_project");
      graph = canonicalizeAgentMapGraph(revision.graph);
    } else {
      const aggregate = await this.store.readAggregate(projectId);
      const proposal = aggregate.proposal;
      if (
        !proposal ||
        proposal.id !== source.proposalId ||
        source.version > proposal.version
      )
        throw new ArchitectureSourceResolutionError("source_not_found");
      let base: AgentMapGraph = { nodes: [], relationships: [] };
      if (proposal.baseRevisionId !== null) {
        const revision = await this.readRevision(
          proposal.baseRevisionId as AgentMapRevisionId,
        );
        if (!revision)
          throw new ArchitectureSourceResolutionError("source_not_found");
        if (revision.projectId !== projectId)
          throw new ArchitectureSourceResolutionError("cross_project");
        base = revision.graph;
      }
      graph = materializeAgentMapProposalVersion(
        canonicalizeAgentMapGraph(base),
        proposal,
        source.version,
      );
    }
    if (computeArchitectureGraphDigest(graph) !== source.graphDigest)
      throw new ArchitectureSourceResolutionError("source_digest_mismatch");
    return { projectId, source: structuredClone(source), graph };
  }
}
