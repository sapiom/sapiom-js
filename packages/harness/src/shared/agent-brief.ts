import { createHash } from "node:crypto";

import type {
  AgentMapVersion,
  PlanNodeId,
  StudioProjectId,
} from "./agent-map.js";
import { canonicalDigest, compareCanonicalStrings } from "./agent-map-canonical.js";
import type {
  AgentBriefDependencyFingerprint,
  AgentBriefDisposition,
  AgentBriefFocusScope,
  AgentBriefHistoryPointer,
  AgentBriefId,
  AgentBriefImpact,
  AgentBriefScopeKey,
  AgentBriefVersion,
  BuildPlanDiagnostic,
  PlanningAssignmentId,
  ProjectBuildPlanVersion,
} from "./build-plan.js";

const deterministicId = (prefix: "brief", seed: string): string => {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Return the canonical, persistence-safe representation of a focus scope. */
export function canonicalizeAgentBriefFocusScope(
  scope: AgentBriefFocusScope,
): AgentBriefFocusScope {
  if (scope.family === "canonical-workstream") {
    return {
      family: "canonical-workstream",
      plannedAgentId: scope.plannedAgentId,
    };
  }
  return {
    family: "ad-hoc-delegation",
    delegationKey: scope.delegationKey,
    parentScopeKey: scope.parentScopeKey,
  };
}

/**
 * Project-bound identity of the selected focus only. Map and plan versions are
 * deliberately excluded so recompilation appends history instead of minting a
 * new logical brief.
 */
export function computeAgentBriefScopeKey(
  projectId: StudioProjectId,
  scope: AgentBriefFocusScope,
): AgentBriefScopeKey {
  return canonicalDigest("sapiom.agent-brief.focus-scope.v1", {
    projectId,
    scope: canonicalizeAgentBriefFocusScope(scope),
  }) as AgentBriefScopeKey;
}

/** Stable logical identity retained across retirement and reactivation. */
export function computeAgentBriefId(
  projectId: StudioProjectId,
  scope: AgentBriefFocusScope,
): AgentBriefId {
  const scopeKey = computeAgentBriefScopeKey(projectId, scope);
  return deterministicId("brief", `${projectId}\0${scopeKey}`) as AgentBriefId;
}

export function canonicalWorkstreamScopes(
  nodeIds: readonly PlanNodeId[],
): AgentBriefFocusScope[] {
  return [...new Set(nodeIds)]
    .sort(compareCanonicalStrings)
    .map((plannedAgentId) => ({
      family: "canonical-workstream" as const,
      plannedAgentId,
    }));
}

export type AgentBriefFocusSelection = Readonly<{
  focusScope: AgentBriefFocusScope;
  /** Explicit narrowing for ad-hoc or nested delegation. */
  nodeIds?: readonly PlanNodeId[];
  /** Optional authored assignment to use as the mission/scope source. */
  assignmentId?: PlanningAssignmentId;
  mission?: string;
  scope?: readonly string[];
  nonGoals?: readonly string[];
}>;

export type PreviousAgentBrief = Readonly<{
  pointer: AgentBriefHistoryPointer;
  version: AgentBriefVersion;
}>;

export type CompileAgentBriefsRequest = Readonly<{
  projectId: StudioProjectId;
  map: AgentMapVersion;
  plan: ProjectBuildPlanVersion;
  mapHistory: readonly AgentMapVersion[];
  planHistory: readonly ProjectBuildPlanVersion[];
  previousBriefs: readonly PreviousAgentBrief[];
  selections: readonly AgentBriefFocusSelection[];
}>;

export type CompiledAgentBriefCandidate = Readonly<{
  scopeKey: AgentBriefScopeKey;
  focusScope: AgentBriefFocusScope;
  disposition: AgentBriefDisposition;
  previous: AgentBriefVersion | null;
  brief: AgentBriefVersion;
  fingerprints: readonly AgentBriefDependencyFingerprint[];
}>;

export type CompileAgentBriefsResult = Readonly<{
  map: AgentMapVersion["contentDigest"];
  plan: ProjectBuildPlanVersion["semanticDigest"];
  briefs: readonly CompiledAgentBriefCandidate[];
  impact: AgentBriefImpact;
  diagnostics: readonly BuildPlanDiagnostic[];
}>;
