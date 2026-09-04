import type { AgentMapVersion, AgentMapVersionRef, ProjectAgentSession, StudioProjectId } from "../shared/agent-map.js";
import { canonicalDigest, compareCanonicalStrings } from "../shared/agent-map-canonical.js";
import type {
  AgentBriefRefreshRequest,
  AgentBriefRefreshResult,
  PreviousAgentBrief,
} from "../shared/agent-brief.js";
import type {
  AgentBriefImpact,
  BuildPlanDiagnostic,
  ProjectBuildPlanVersion,
  ProjectBuildPlanVersionRef,
} from "../shared/build-plan.js";
import { agentMapVersionRefsEqual, projectBuildPlanVersionRefsEqual } from "../shared/build-plan.js";
import { compileCanonicalWorkstreamBriefs, projectFocusedBriefs } from "./agent-brief-compiler.js";
import type { ProjectPlanningAggregateV2 } from "./agent-map-aggregate-migration.js";
import { AgentMapWorkspaceStoreError } from "./agent-map-workspace-store.js";
import { BuildPlanStore } from "./build-plan-store.js";
import { parseAgentBriefRefreshRequest } from "./build-plan-schema.js";
import { evaluateAgentBriefImpact } from "./build-plan-impact-evaluator.js";
import {
  serializeFocusedSessionContext,
  type FocusedSessionContextResult,
} from "./focused-session-context.js";

export type AgentBriefServiceErrorCode =
  | "malformed_input"
  | "source_mismatch"
  | "request_id_reused"
  | "request_id_expired"
  | "storage_unavailable";

export class AgentBriefServiceError extends Error {
  constructor(readonly code: AgentBriefServiceErrorCode) {
    super(code.replace(/_/gu, " "));
    this.name = "AgentBriefServiceError";
  }
}

export interface AgentBriefServiceOptions {
  compileCanonical?: typeof compileCanonicalWorkstreamBriefs;
  compileFocused?: typeof projectFocusedBriefs;
  onOutcome?: (event: Readonly<{
    projectId: StudioProjectId;
    sessionId: string;
    outcome: "succeeded" | "replayed" | "unchanged" | "diagnostic" | "failed";
    createdCount: number;
    newVersionCount: number;
    unchangedCount: number;
    retiredCount: number;
    impactedWorkstreamCount: number;
    diagnosticCategory: BuildPlanDiagnostic["code"] | null;
    projectionExactCount: number;
    projectionTruncatedCount: number;
    projectionRejectedCount: number;
  }>) => void | Promise<void>;
}

const mapRef = (version: AgentMapVersion): AgentMapVersionRef => ({
  projectId: version.projectId,
  versionId: version.versionId,
  contentDigest: version.contentDigest,
});
const planRef = (version: ProjectBuildPlanVersion): ProjectBuildPlanVersionRef => ({
  projectId: version.projectId,
  planId: version.planId,
  versionId: version.versionId,
  semanticDigest: version.semanticDigest,
});
const emptyImpact = (): AgentBriefImpact => evaluateAgentBriefImpact({
  previousGraph: { nodes: [], relationships: [] },
  nextGraph: { nodes: [], relationships: [] },
  previousBriefs: [],
  previousFingerprints: new Map(),
  candidates: [],
});
const boundedDiagnostics = (values: readonly BuildPlanDiagnostic[]): BuildPlanDiagnostic[] =>
  [...new Map(values.map((value) => [canonicalDigest("sapiom.agent-brief.diagnostic.v1", value), value])).values()]
    .sort((left, right) => compareCanonicalStrings(
      `${left.path}\0${left.code}\0${left.relatedIds.join("\0")}`,
      `${right.path}\0${right.code}\0${right.relatedIds.join("\0")}`,
    ))
    .slice(0, 64);

function currentSources(
  aggregate: ProjectPlanningAggregateV2,
  request: AgentBriefRefreshRequest,
): { map: AgentMapVersion; plan: ProjectBuildPlanVersion } {
  const expectedMap = { projectId: aggregate.projectId, ...request.expectedMap } as AgentMapVersionRef;
  const expectedPlan = { projectId: aggregate.projectId, ...request.expectedPlan } as ProjectBuildPlanVersionRef;
  if (!aggregate.current.map || !aggregate.current.buildPlan ||
    !agentMapVersionRefsEqual(aggregate.current.map, expectedMap) ||
    !projectBuildPlanVersionRefsEqual(aggregate.current.buildPlan, expectedPlan))
    throw new AgentBriefServiceError("source_mismatch");
  const map = aggregate.mapVersions.find(({ versionId }) => versionId === expectedMap.versionId);
  const plan = aggregate.buildPlanVersions.find(({ versionId }) => versionId === expectedPlan.versionId);
  if (!map || !plan || !agentMapVersionRefsEqual(mapRef(map), expectedMap) ||
    !projectBuildPlanVersionRefsEqual(planRef(plan), expectedPlan) ||
    !agentMapVersionRefsEqual(plan.map, expectedMap))
    throw new AgentBriefServiceError("source_mismatch");
  return { map, plan };
}

function previousBriefs(aggregate: ProjectPlanningAggregateV2): PreviousAgentBrief[] {
  return Object.values(aggregate.current.briefsByScope)
    .sort((left, right) => compareCanonicalStrings(left.scopeKey, right.scopeKey))
    .flatMap((pointer) => {
      const version = aggregate.briefVersionsById[pointer.briefId]?.at(-1);
      return version ? [{ pointer, version }] : [];
    });
}

export class AgentBriefService {
  private readonly compileCanonical: typeof compileCanonicalWorkstreamBriefs;
  private readonly compileFocused: typeof projectFocusedBriefs;

  constructor(private readonly store: BuildPlanStore, private readonly options: AgentBriefServiceOptions = {}) {
    this.compileCanonical = options.compileCanonical ?? compileCanonicalWorkstreamBriefs;
    this.compileFocused = options.compileFocused ?? projectFocusedBriefs;
  }

  async refresh(identity: ProjectAgentSession, input: unknown): Promise<AgentBriefRefreshResult> {
    let request: AgentBriefRefreshRequest;
    try {
      request = parseAgentBriefRefreshRequest(input) as unknown as AgentBriefRefreshRequest;
    } catch {
      throw new AgentBriefServiceError("malformed_input");
    }
    const requestDigest = canonicalDigest("sapiom.agent-brief.refresh-request.v1", request);
    const aggregate = await this.store.read(identity.projectId);
    const replay = this.replay(aggregate, identity, request, requestDigest);
    if (replay) {
      this.emit(identity, replay, "replayed");
      return replay;
    }
    const { map, plan } = currentSources(aggregate, request);
    const shared = { projectId: identity.projectId, map, plan,
      mapHistory: aggregate.mapVersions, planHistory: aggregate.buildPlanVersions,
      previousBriefs: previousBriefs(aggregate) };
    let compiled;
    try {
      compiled = request.focus.mode === "canonical"
        ? this.compileCanonical(shared)
        : this.compileFocused({ ...shared, selections: request.focus.selections });
    } catch {
      const result = this.diagnosticResult(map, plan, [{ code: "brief-compilation-failed", severity: "error",
        path: "briefCompiler", relatedIds: [] }]);
      this.emit(identity, result, "diagnostic");
      return result;
    }
    const projectionOutcomes: FocusedSessionContextResult[] = compiled.briefs
      .filter(({ disposition }) => disposition !== "retired")
      .map(({ brief }) => {
        const exactMap = aggregate.mapVersions.find(({ versionId }) => versionId === brief.map.versionId);
        const exactPlan = aggregate.buildPlanVersions.find(({ versionId }) => versionId === brief.plan.versionId);
        return exactMap && exactPlan
          ? serializeFocusedSessionContext({ map: exactMap, plan: exactPlan, brief })
          : { ok: false as const, projection: null, contextDigest: null, sizeBytes: 0, outcome: "rejected" as const,
              diagnostics: [{ code: "source-lineage-mismatch" as const, severity: "error" as const,
                path: "focusedContext.references", relatedIds: [brief.briefId] }] };
      });
    compiled = { ...compiled,
      diagnostics: boundedDiagnostics([
        ...compiled.diagnostics,
        ...projectionOutcomes.flatMap(({ diagnostics }) => diagnostics),
      ]) };
    const entries = compiled.briefs.filter(({ disposition }) => disposition !== "unchanged")
      .map(({ brief, disposition }) => ({ version: brief,
        status: disposition === "retired" ? "retired" as const : "active" as const }));
    if (entries.length > 128) {
      const result = this.diagnosticResult(map, plan, boundedDiagnostics([...compiled.diagnostics, {
        code: "brief-limit-exceeded", severity: "error", path: "briefs", relatedIds: [],
      }]));
      this.emit(identity, result, "diagnostic", projectionOutcomes);
      return result;
    }
    if (entries.length === 0) {
      const result = this.result(map, plan, compiled, false, false);
      this.emit(identity, result, compiled.diagnostics.length > 0 ? "diagnostic" : "unchanged", projectionOutcomes);
      return result;
    }
    try {
      const append = await this.store.appendBriefVersions(identity.projectId, {
        actor: { userId: identity.userId, sessionId: identity.sessionId },
        requestId: request.requestId,
        requestDigest,
        expectedMap: mapRef(map),
        expectedPlan: planRef(plan),
        entries,
        createdAt: plan.createdAt,
      });
      const result = this.result(map, plan, compiled, append.replayed, true);
      this.emit(identity, result, append.replayed ? "replayed" : "succeeded", projectionOutcomes);
      return result;
    } catch (error) {
      this.emit(identity, this.diagnosticResult(map, plan, []), "failed");
      if (error instanceof AgentMapWorkspaceStoreError) {
        if (error.code === "storage_unavailable") throw new AgentBriefServiceError("storage_unavailable");
        throw new AgentBriefServiceError("source_mismatch");
      }
      throw new AgentBriefServiceError("storage_unavailable");
    }
  }

  private replay(
    aggregate: ProjectPlanningAggregateV2,
    identity: ProjectAgentSession,
    request: AgentBriefRefreshRequest,
    requestDigest: string,
  ): AgentBriefRefreshResult | null {
    const matches = (entry: { userId: string; sessionId: string; requestId: string }) =>
      entry.userId === identity.userId && entry.sessionId === identity.sessionId && entry.requestId === request.requestId;
    const receipt = aggregate.requestReceipts.find(matches);
    if (receipt) {
      if (receipt.operation !== "brief_append" || receipt.requestDigest !== requestDigest)
        throw new AgentBriefServiceError("request_id_reused");
      const { map, plan } = currentSources(aggregate, request);
      const refs = (receipt.result as { versions?: readonly { versionId: string }[] }).versions ?? [];
      const briefs = refs.flatMap((ref) => {
        const version = Object.values(aggregate.briefVersionsById).flat()
          .find((entry) => entry.versionId === ref.versionId);
        const pointer = version ? aggregate.current.briefsByScope[version.scopeKey] : undefined;
        return version && pointer ? [{ scopeKey: version.scopeKey, briefId: version.briefId,
          versionId: version.versionId, version: version.version, disposition: "unchanged" as const,
          status: pointer.status }] : [];
      });
      return { replayed: true, persisted: true, map: mapRef(map), plan: planRef(plan), briefs,
        impact: emptyImpact(), diagnostics: [] };
    }
    if (aggregate.requestTombstones.some(matches)) throw new AgentBriefServiceError("request_id_expired");
    return null;
  }

  private result(
    map: AgentMapVersion,
    plan: ProjectBuildPlanVersion,
    compiled: ReturnType<typeof compileCanonicalWorkstreamBriefs>,
    replayed: boolean,
    persisted: boolean,
  ): AgentBriefRefreshResult {
    return { replayed, persisted, map: mapRef(map), plan: planRef(plan),
      briefs: compiled.briefs.map(({ scopeKey, disposition, brief }) => ({ scopeKey,
        briefId: brief.briefId, versionId: brief.versionId, version: brief.version, disposition,
        status: disposition === "retired" ? "retired" : "active" })),
      impact: compiled.impact, diagnostics: compiled.diagnostics };
  }

  private diagnosticResult(
    map: AgentMapVersion,
    plan: ProjectBuildPlanVersion,
    diagnostics: readonly BuildPlanDiagnostic[],
  ): AgentBriefRefreshResult {
    return { replayed: false, persisted: false, map: mapRef(map), plan: planRef(plan), briefs: [],
      impact: emptyImpact(), diagnostics };
  }

  private emit(
    identity: ProjectAgentSession,
    result: AgentBriefRefreshResult,
    outcome: Parameters<NonNullable<AgentBriefServiceOptions["onOutcome"]>>[0]["outcome"],
    projections: readonly FocusedSessionContextResult[] = [],
  ): void {
    const count = (disposition: AgentBriefRefreshResult["briefs"][number]["disposition"]) =>
      result.briefs.filter((brief) => brief.disposition === disposition).length;
    try {
      void Promise.resolve(this.options.onOutcome?.({ projectId: identity.projectId, sessionId: identity.sessionId,
        outcome, createdCount: count("created"), newVersionCount: count("new-version"),
        unchangedCount: count("unchanged"), retiredCount: count("retired"),
        impactedWorkstreamCount: Math.min(256, result.impact.affectedWorkstreamCount),
        diagnosticCategory: result.diagnostics[0]?.code ?? null,
        projectionExactCount: projections.filter(({ outcome: value }) => value === "exact").length,
        projectionTruncatedCount: projections.filter(({ outcome: value }) => value === "truncated").length,
        projectionRejectedCount: projections.filter(({ outcome: value }) => value === "rejected").length,
      })).catch(() => {});
    } catch { /* content-free telemetry never changes brief behavior */ }
  }
}
