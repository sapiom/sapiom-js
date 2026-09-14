import type {
  ProjectAgentActorRef,
  ProjectMutationOrigin,
  StudioProjectId,
} from "../shared/agent-map.js";
import type {
  ProjectBuildPlanVersion,
  ProjectBuildPlanVersionId,
  ProjectBuildPlanVersionRef,
} from "../shared/build-plan.js";
import { parseProjectBuildPlanVersion } from "../shared/build-plan-codec.js";
import { computeBuildPlanRecordDigest } from "./build-plan-canonicalization.js";
import type { ProjectPlanningAggregateV2 } from "./agent-map-aggregate-migration.js";
import {
  AgentMapWorkspaceStore,
  type AppendBriefVersionsRequest,
  type AppendBriefVersionsResult,
} from "./agent-map-workspace-store.js";

const planRef = (version: ProjectBuildPlanVersion): ProjectBuildPlanVersionRef => ({
  projectId: version.projectId,
  planId: version.planId,
  versionId: version.versionId,
  semanticDigest: version.semanticDigest,
});
const refsEqual = (left: ProjectBuildPlanVersionRef, right: ProjectBuildPlanVersionRef) =>
  left.projectId === right.projectId && left.planId === right.planId &&
  left.versionId === right.versionId && left.semanticDigest === right.semanticDigest;

/** Pure append-only restoration primitive for a future history UI. */
export function appendRestoredBuildPlanVersion(input: Readonly<{
  projectId: StudioProjectId;
  versions: readonly ProjectBuildPlanVersion[];
  expectedCurrent: ProjectBuildPlanVersionRef;
  historical: ProjectBuildPlanVersionRef;
  versionId: ProjectBuildPlanVersionId;
  actor: ProjectAgentActorRef;
  createdAt: string;
  origin: ProjectMutationOrigin;
}>): ProjectBuildPlanVersion {
  const seen = new Set<string>();
  input.versions.forEach((version, index) => {
    parseProjectBuildPlanVersion(version, input.projectId);
    if (version.version !== index + 1 ||
      version.parentVersionId !== (input.versions[index - 1]?.versionId ?? null) ||
      seen.has(version.versionId)) throw new TypeError("invalid build plan history");
    seen.add(version.versionId);
  });
  const current = input.versions.at(-1);
  const historical = input.versions.find(({ versionId }) => versionId === input.historical.versionId);
  if (!current || !refsEqual(planRef(current), input.expectedCurrent))
    throw new TypeError("stale build plan restoration");
  if (!historical || historical.projectId !== input.projectId || historical.planId !== current.planId ||
    !refsEqual(planRef(historical), input.historical))
    throw new TypeError("unknown build plan restoration source");
  const base = { ...historical,
    versionId: input.versionId,
    version: current.version + 1,
    parentVersionId: current.versionId,
    changeKind: "restored" as const,
    restoredFromVersionId: historical.versionId,
    authoredBy: input.actor,
    createdAt: input.createdAt,
    origin: input.origin,
  };
  return { ...base, recordDigest: computeBuildPlanRecordDigest(base) };
}

/** One storage authority for map, plan, and reserved brief histories. */
export class BuildPlanStore {
  constructor(readonly aggregateStore: AgentMapWorkspaceStore) {}

  read(projectId: StudioProjectId): Promise<ProjectPlanningAggregateV2> {
    return this.aggregateStore.readAggregate(projectId);
  }

  transact<T>(projectId: StudioProjectId, operation: (
    aggregate: ProjectPlanningAggregateV2,
  ) => Promise<{ value: T; next?: ProjectPlanningAggregateV2 }>): Promise<T> {
    return this.aggregateStore.transact(projectId, operation);
  }

  appendBriefVersions(
    projectId: StudioProjectId,
    request: AppendBriefVersionsRequest,
  ): Promise<AppendBriefVersionsResult> {
    return this.aggregateStore.appendBriefVersions(projectId, request);
  }
}
