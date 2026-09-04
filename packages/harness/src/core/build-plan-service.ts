import { createHash } from "node:crypto";

import type {
  AgentMapVersionRef,
  ProjectAgentSession,
  StudioProjectId,
} from "../shared/agent-map.js";
import { canonicalJson } from "../shared/agent-map-canonical.js";
import type {
  BuildPlanDiagnostic,
  BuildPlanIdMapping,
  BuildPlanReadResult,
  ProjectBuildPlanContent,
  ProjectBuildPlanId,
  ProjectBuildPlanVersion,
  ProjectBuildPlanVersionId,
  ProjectBuildPlanVersionRef,
  ProjectMutationReceipt,
} from "../shared/build-plan.js";
import {
  BUILD_PLAN_ID_MAPPING_LIMIT,
  BUILD_PLAN_VERSION_HISTORY_LIMIT,
  PROJECT_MUTATION_RECEIPT_LIMIT,
  PROJECT_MUTATION_TOMBSTONE_LIMIT,
  agentMapVersionRefsEqual,
  projectBuildPlanVersionRefsEqual,
} from "../shared/build-plan.js";
import { parseProjectBuildPlanContent } from "../shared/build-plan-codec.js";
import {
  computeBuildPlanRecordDigest,
  computeBuildPlanRequestDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";
import { validateProjectBuildPlanContent } from "./build-plan-contract-validator.js";
import type { ProjectPlanningAggregateV2 } from "./agent-map-aggregate-migration.js";
import { AgentMapVersionResolver } from "./agent-map-version-resolver.js";
import { BuildPlanStore } from "./build-plan-store.js";
import {
  parseBuildPlanApplyRequest,
  parseBuildPlanReadRequest,
  parseBuildPlanRebaseRequest,
  type BuildPlanApplyRequest,
  type BuildPlanContentInput,
  type BuildPlanRebaseRequest,
} from "./build-plan-schema.js";

export const BUILD_PLAN_HISTORY_SUMMARY_LIMIT = 50;
export const BUILD_PLAN_RECEIPT_RETENTION_LIMIT = 256;

export type BuildPlanServiceErrorCode =
  | "malformed_input"
  | "plan_not_found"
  | "source_mismatch"
  | "stale_plan_conflict"
  | "request_id_reused"
  | "request_id_expired"
  | "validation_failed"
  | "rebase_resolution_required"
  | "invalid_rebase_resolution"
  | "quota_exceeded";

export class BuildPlanServiceError extends Error {
  constructor(
    readonly code: BuildPlanServiceErrorCode,
    readonly details: Readonly<{
      currentPlan: ProjectBuildPlanVersionRef | null;
      affectedIds: readonly string[];
      affectedPaths: readonly string[];
      diagnostics: readonly BuildPlanDiagnostic[];
    }> = { currentPlan: null, affectedIds: [], affectedPaths: [], diagnostics: [] },
  ) {
    super(code.replace(/_/gu, " "));
    this.name = "BuildPlanServiceError";
  }
}

export interface BuildPlanMutationResult {
  replayed: boolean;
  created: boolean;
  plan: ProjectBuildPlanVersionRef;
  mappings: readonly BuildPlanIdMapping[];
  diagnostics: readonly BuildPlanDiagnostic[];
}

export interface BuildPlanValidationResult extends BuildPlanMutationResult {
  valid: true;
  preview: ProjectBuildPlanVersion;
}

export interface BuildPlanServiceOptions {
  now?: () => Date;
  receiptRetentionLimit?: number;
  versionHistoryLimit?: number;
  onOutcome?: (event: Readonly<{
    operation: "read" | "validate" | "apply" | "rebase";
    outcome: "succeeded" | "replayed" | "no_op" | "conflict" | "failed";
    projectId: StudioProjectId;
    sessionId: string;
    version: number | null;
    diagnosticCount: number;
    affectedCount: number;
  }>) => void | Promise<void>;
}

type IdInput = string | { clientRef: string };
type EntityCollection = "milestones" | "sequenceGates" | "repositoryIntents" |
  "decisions" | "assignments" | "unresolvedDecisions" | "risks";
const ENTITY_COLLECTIONS: readonly EntityCollection[] = [
  "milestones", "sequenceGates", "repositoryIntents", "decisions", "assignments", "unresolvedDecisions", "risks",
];
const SET_FIELDS = ["nonGoals", "sharedConstraints", "integrationCriteria", "acceptanceCriteria"] as const;

const refFor = (plan: ProjectBuildPlanVersion): ProjectBuildPlanVersionRef => ({
  projectId: plan.projectId,
  planId: plan.planId,
  versionId: plan.versionId,
  semanticDigest: plan.semanticDigest,
});
const toolPlanRef = (projectId: StudioProjectId, ref: BuildPlanApplyRequest["expectedPlan"]): ProjectBuildPlanVersionRef | null =>
  ref === null ? null : { projectId, ...ref } as ProjectBuildPlanVersionRef;
const toolMapRef = (projectId: StudioProjectId, ref: BuildPlanApplyRequest["expectedMap"]): AgentMapVersionRef =>
  ({ projectId, ...ref }) as AgentMapVersionRef;
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const idKey = (value: IdInput) => typeof value === "string" ? value : `client:${value.clientRef}`;

function deterministicId(prefix: string, input: {
  identity: ProjectAgentSession;
  requestId: string;
  requestDigest: string;
  entityKind: string;
  clientRef: string;
}): string {
  const seed = ["sapiom.build-plan.id.v1", input.identity.projectId, input.identity.userId,
    input.identity.sessionId, input.requestId, input.requestDigest, input.entityKind, input.clientRef].join("\0");
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeContentInput(content: BuildPlanContentInput): unknown {
  const strings = (values: readonly string[]) => [...values].sort(compare);
  const entities = <T extends { id: IdInput }>(values: readonly T[]) => [...values].sort((a, b) => compare(idKey(a.id), idKey(b.id)));
  return {
    ...content,
    nonGoals: strings(content.nonGoals),
    milestones: [...content.milestones].sort((a, b) => a.ordinal - b.ordinal || compare(idKey(a.id), idKey(b.id)))
      .map((entry) => ({ ...entry, dependsOn: [...entry.dependsOn].sort((a, b) => compare(idKey(a), idKey(b))) })),
    sequenceGates: [...content.sequenceGates].sort((a, b) => a.ordinal - b.ordinal || compare(idKey(a.id), idKey(b.id)))
      .map((entry) => ({ ...entry, milestoneIds: [...entry.milestoneIds].sort((a, b) => compare(idKey(a), idKey(b))) })),
    sharedConstraints: strings(content.sharedConstraints),
    repositoryIntents: entities(content.repositoryIntents).map((entry) => ({ ...entry,
      packages: strings(entry.packages), ownershipBoundaries: strings(entry.ownershipBoundaries) })),
    integrationCriteria: strings(content.integrationCriteria),
    acceptanceCriteria: strings(content.acceptanceCriteria),
    decisions: entities(content.decisions),
    assignments: entities(content.assignments).map((entry) => ({ ...entry, scope: strings(entry.scope),
      nonGoals: strings(entry.nonGoals), dependencies: entities(entry.dependencies).map((dependency) => ({ ...dependency,
        relationshipIds: strings(dependency.relationshipIds) })) })),
    unresolvedDecisions: entities(content.unresolvedDecisions),
    risks: entities(content.risks),
  };
}

function requestDigest(request: BuildPlanApplyRequest | BuildPlanRebaseRequest): string {
  if ("operations" in request) return computeBuildPlanRequestDigest({ schemaVersion: request.schemaVersion,
    expectedMap: request.expectedMap, expectedPlan: request.expectedPlan,
    operations: [{ op: "replace-content", content: normalizeContentInput(request.operations[0].content) }] });
  return computeBuildPlanRequestDigest({ schemaVersion: request.schemaVersion, expectedPlan: request.expectedPlan,
    fromMap: request.fromMap, toMap: request.toMap,
    resolutions: [...request.resolutions].sort((a, b) => compare(canonicalJson(a), canonicalJson(b))) });
}

function materializeContent(
  identity: ProjectAgentSession,
  request: BuildPlanApplyRequest,
  digest: string,
): { content: ProjectBuildPlanContent; mappings: BuildPlanIdMapping[] } {
  const source = request.operations[0].content;
  const registrations = new Map<string, { prefix: string; kind: BuildPlanIdMapping["kind"] }>();
  const mappings: BuildPlanIdMapping[] = [];
  const register = (value: IdInput | null, prefix: string, kind: BuildPlanIdMapping["kind"]) => {
    if (value === null || typeof value === "string") return;
    const prior = registrations.get(value.clientRef);
    if (prior && (prior.prefix !== prefix || prior.kind !== kind)) throw new BuildPlanServiceError("malformed_input");
    registrations.set(value.clientRef, { prefix, kind });
  };
  source.milestones.forEach(({ id }) => register(id, "milestone", "milestone"));
  source.sequenceGates.forEach(({ id }) => register(id, "gate", "sequence-gate"));
  source.repositoryIntents.forEach(({ id }) => register(id, "repository", "repository-intent"));
  [...source.decisions, ...source.unresolvedDecisions].forEach(({ id }) => register(id, "decision", "decision"));
  source.assignments.forEach((assignment) => {
    register(assignment.id, "work", "assignment");
    register(assignment.briefId, "brief", "brief");
    assignment.dependencies.forEach(({ id }) => register(id, "dependency", "dependency"));
  });
  source.risks.forEach(({ id }) => register(id, "risk", "risk"));
  if (registrations.size > BUILD_PLAN_ID_MAPPING_LIMIT) throw new BuildPlanServiceError("quota_exceeded");
  const resolved = new Map<string, string>();
  for (const [clientRef, registration] of [...registrations].sort(([left], [right]) => compare(left, right))) {
    const id = deterministicId(registration.prefix, { identity, requestId: request.requestId, requestDigest: digest,
      entityKind: registration.kind, clientRef });
    resolved.set(clientRef, id);
    mappings.push({ kind: registration.kind, clientRef, id });
  }
  const resolve = (value: IdInput, prefix: string): string => {
    if (typeof value === "string") return value;
    const registration = registrations.get(value.clientRef);
    const id = resolved.get(value.clientRef);
    if (!registration || registration.prefix !== prefix || !id) throw new BuildPlanServiceError("malformed_input");
    return id;
  };
  const content = {
    ...source,
    milestones: source.milestones.map((entry) => ({ ...entry, id: resolve(entry.id, "milestone"),
      dependsOn: entry.dependsOn.map((value) => resolve(value, "milestone")) })),
    sequenceGates: source.sequenceGates.map((entry) => ({ ...entry, id: resolve(entry.id, "gate"),
      milestoneIds: entry.milestoneIds.map((value) => resolve(value, "milestone")) })),
    repositoryIntents: source.repositoryIntents.map((entry) => ({ ...entry, id: resolve(entry.id, "repository") })),
    decisions: source.decisions.map((entry) => ({ ...entry, id: resolve(entry.id, "decision") })),
    assignments: source.assignments.map((entry) => ({ ...entry, id: resolve(entry.id, "work"),
      briefId: entry.briefId === null ? null : resolve(entry.briefId, "brief"),
      dependencies: entry.dependencies.map((dependency) => ({ ...dependency, id: resolve(dependency.id, "dependency") })) })),
    unresolvedDecisions: source.unresolvedDecisions.map((entry) => ({ ...entry, id: resolve(entry.id, "decision") })),
    risks: source.risks.map((entry) => ({ ...entry, id: resolve(entry.id, "risk") })),
  };
  try { return { content: parseProjectBuildPlanContent(content), mappings }; }
  catch { throw new BuildPlanServiceError("malformed_input"); }
}

function activeBriefIds(aggregate: ProjectPlanningAggregateV2): Set<string> {
  return new Set(Object.values(aggregate.current.briefsByScope)
    .filter(({ status }) => status === "active").map(({ briefId }) => briefId));
}

function resolveMap(aggregate: ProjectPlanningAggregateV2, ref: AgentMapVersionRef) {
  return new AgentMapVersionResolver(aggregate.projectId, aggregate.mapVersions, aggregate.current.map).readExact(ref);
}

function resolvePlan(aggregate: ProjectPlanningAggregateV2, ref: ProjectBuildPlanVersionRef): ProjectBuildPlanVersion {
  if (ref.projectId !== aggregate.projectId) throw new BuildPlanServiceError("source_mismatch");
  const plan = aggregate.buildPlanVersions.find(({ versionId }) => versionId === ref.versionId);
  if (!plan) throw new BuildPlanServiceError("plan_not_found", { currentPlan: aggregate.current.buildPlan,
    affectedIds: [ref.versionId], affectedPaths: [], diagnostics: [] });
  if (!projectBuildPlanVersionRefsEqual(refFor(plan), ref)) throw new BuildPlanServiceError("source_mismatch", {
    currentPlan: aggregate.current.buildPlan, affectedIds: [ref.versionId], affectedPaths: [], diagnostics: [],
  });
  return plan;
}

function contentDiff(base: ProjectBuildPlanContent, desired: ProjectBuildPlanContent): string[] {
  const touches: string[] = [];
  if (base.outcome !== desired.outcome) touches.push("outcome");
  for (const field of SET_FIELDS) if (!equal(base[field], desired[field])) touches.push(field);
  for (const field of ENTITY_COLLECTIONS) {
    const before = new Map(base[field].map((entry) => [entry.id, entry]));
    const after = new Map(desired[field].map((entry) => [entry.id, entry]));
    for (const id of new Set([...before.keys(), ...after.keys()]))
      if (!equal(before.get(id), after.get(id))) touches.push(`${field}:${id}`);
  }
  return touches.sort(compare);
}

function mergeContent(
  base: ProjectBuildPlanContent,
  desired: ProjectBuildPlanContent,
  current: ProjectBuildPlanContent,
): ProjectBuildPlanContent {
  const touches = new Set(contentDiff(base, desired));
  const merged = structuredClone(current);
  if (touches.has("outcome")) merged.outcome = desired.outcome;
  for (const field of SET_FIELDS) if (touches.has(field)) merged[field] = structuredClone(desired[field]) as never;
  for (const field of ENTITY_COLLECTIONS) {
    const desiredById = new Map(desired[field].map((entry) => [entry.id, entry]));
    const values = new Map(current[field].map((entry) => [entry.id, entry]));
    for (const touch of touches) {
      if (!touch.startsWith(`${field}:`)) continue;
      const id = touch.slice(field.length + 1);
      const value = desiredById.get(id);
      if (value) values.set(id, structuredClone(value)); else values.delete(id);
    }
    (merged as unknown as Record<string, unknown>)[field] = [...values.values()];
  }
  return parseProjectBuildPlanContent(merged);
}

function conflict(
  aggregate: ProjectPlanningAggregateV2,
  paths: readonly string[],
  diagnostics: readonly BuildPlanDiagnostic[] = [],
): BuildPlanServiceError {
  const affectedIds = paths.filter((path) => path.includes(":")).map((path) => path.slice(path.indexOf(":") + 1)).sort(compare);
  return new BuildPlanServiceError("stale_plan_conflict", { currentPlan: aggregate.current.buildPlan,
    affectedIds: [...new Set(affectedIds)], affectedPaths: [...paths].sort(compare), diagnostics });
}

interface PreparedMutation {
  plan: ProjectBuildPlanVersion;
  mappings: BuildPlanIdMapping[];
  diagnostics: BuildPlanDiagnostic[];
  noOp: boolean;
}

export class BuildPlanService {
  private readonly now: () => Date;
  private readonly receiptRetentionLimit: number;
  private readonly versionHistoryLimit: number;

  constructor(private readonly store: BuildPlanStore, private readonly options: BuildPlanServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    const limit = options.receiptRetentionLimit ?? BUILD_PLAN_RECEIPT_RETENTION_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROJECT_MUTATION_RECEIPT_LIMIT)
      throw new RangeError("invalid build-plan receipt retention limit");
    this.receiptRetentionLimit = limit;
    const historyLimit = options.versionHistoryLimit ?? BUILD_PLAN_VERSION_HISTORY_LIMIT;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > BUILD_PLAN_VERSION_HISTORY_LIMIT)
      throw new RangeError("invalid build-plan version history limit");
    this.versionHistoryLimit = historyLimit;
  }

  async read(identity: ProjectAgentSession, input: unknown): Promise<BuildPlanReadResult> {
    let selector;
    try { selector = parseBuildPlanReadRequest(input); } catch { throw new BuildPlanServiceError("malformed_input"); }
    const aggregate = await this.store.read(identity.projectId);
    const plan = selector.kind === "current"
      ? aggregate.buildPlanVersions.at(-1) ?? null
      : resolvePlan(aggregate, { projectId: identity.projectId, planId: selector.planId,
        versionId: selector.versionId, semanticDigest: selector.semanticDigest } as unknown as ProjectBuildPlanVersionRef);
    const graph = plan ? resolveMap(aggregate, plan.map).graph : aggregate.mapVersions.at(-1)?.graph ?? { nodes: [], relationships: [] };
    const diagnostics = plan ? validateProjectBuildPlanContent(plan.content, graph, activeBriefIds(aggregate)) : [];
    const result: BuildPlanReadResult = { current: structuredClone(aggregate.current), plan: plan ? structuredClone(plan) : null,
      diagnostics, history: aggregate.buildPlanVersions.slice(-BUILD_PLAN_HISTORY_SUMMARY_LIMIT).map((version) => ({
        ref: refFor(version), version: version.version, changeKind: version.changeKind, map: version.map, createdAt: version.createdAt,
      })) };
    this.emit(identity, "read", "succeeded", plan?.version ?? null, diagnostics.length, 0);
    return result;
  }

  async validate(identity: ProjectAgentSession, input: unknown): Promise<BuildPlanValidationResult> {
    const request = this.parseApply(input);
    const aggregate = await this.store.read(identity.projectId);
    const prepared = this.prepareApply(identity, aggregate, request, requestDigest(request), this.now().toISOString());
    this.emit(identity, "validate", "succeeded", prepared.plan.version, prepared.diagnostics.length, 0);
    return { valid: true, replayed: false, created: !prepared.noOp, plan: refFor(prepared.plan),
      mappings: prepared.mappings, diagnostics: prepared.diagnostics, preview: prepared.plan };
  }

  async apply(identity: ProjectAgentSession, input: unknown): Promise<BuildPlanMutationResult> {
    const request = this.parseApply(input);
    const digest = requestDigest(request);
    const preflight = await this.store.read(identity.projectId);
    const replay = this.replay(preflight, identity, request.requestId, digest, "build_plan_apply");
    if (replay) {
      this.emit(identity, "apply", "replayed", this.versionOf(replay, preflight), replay.diagnostics.length, 0);
      return replay;
    }
    // Preparation outside the project lock is side-effect free. The complete
    // preparation is repeated after the receipt check under the file lock.
    this.prepareApply(identity, preflight, request, digest, this.now().toISOString());
    let noOp = false;
    let diagnostics = 0;
    const result = await this.store.transact(identity.projectId, async (aggregate) => {
      const won = this.replay(aggregate, identity, request.requestId, digest, "build_plan_apply");
      if (won) return { value: won };
      const prepared = this.prepareApply(identity, aggregate, request, digest, this.now().toISOString());
      noOp = prepared.noOp;
      diagnostics = prepared.diagnostics.length;
      return this.commit(identity, aggregate, request.requestId, digest, "build_plan_apply", prepared);
    });
    this.emit(identity, "apply", result.replayed ? "replayed" : noOp ? "no_op" : "succeeded",
      this.versionOf(result, preflight), diagnostics, 0);
    return result;
  }

  async rebase(identity: ProjectAgentSession, input: unknown): Promise<BuildPlanMutationResult> {
    let request: BuildPlanRebaseRequest;
    try { request = parseBuildPlanRebaseRequest(input); } catch { throw new BuildPlanServiceError("malformed_input"); }
    const digest = requestDigest(request);
    const preflight = await this.store.read(identity.projectId);
    const replay = this.replay(preflight, identity, request.requestId, digest, "build_plan_rebase");
    if (replay) {
      this.emit(identity, "rebase", "replayed", this.versionOf(replay, preflight), replay.diagnostics.length, 0);
      return replay;
    }
    this.prepareRebase(identity, preflight, request, digest, this.now().toISOString());
    let noOp = false;
    let diagnostics = 0;
    const result = await this.store.transact(identity.projectId, async (aggregate) => {
      const won = this.replay(aggregate, identity, request.requestId, digest, "build_plan_rebase");
      if (won) return { value: won };
      const prepared = this.prepareRebase(identity, aggregate, request, digest, this.now().toISOString());
      noOp = prepared.noOp;
      diagnostics = prepared.diagnostics.length;
      return this.commit(identity, aggregate, request.requestId, digest, "build_plan_rebase", prepared);
    });
    this.emit(identity, "rebase", result.replayed ? "replayed" : noOp ? "no_op" : "succeeded",
      this.versionOf(result, preflight), diagnostics, 0);
    return result;
  }

  private parseApply(input: unknown): BuildPlanApplyRequest {
    try { return parseBuildPlanApplyRequest(input); } catch { throw new BuildPlanServiceError("malformed_input"); }
  }

  private prepareApply(
    identity: ProjectAgentSession,
    aggregate: ProjectPlanningAggregateV2,
    request: BuildPlanApplyRequest,
    digest: string,
    createdAt: string,
  ): PreparedMutation {
    const expectedMap = toolMapRef(identity.projectId, request.expectedMap);
    if (!aggregate.current.map || !agentMapVersionRefsEqual(aggregate.current.map, expectedMap))
      throw new BuildPlanServiceError("source_mismatch", { currentPlan: aggregate.current.buildPlan,
        affectedIds: [request.expectedMap.versionId], affectedPaths: ["expectedMap"], diagnostics: [] });
    const map = resolveMap(aggregate, expectedMap);
    const expectedPlanRef = toolPlanRef(identity.projectId, request.expectedPlan);
    const current = aggregate.buildPlanVersions.at(-1) ?? null;
    if ((current === null) !== (expectedPlanRef === null)) throw conflict(aggregate, ["expectedPlan"]);
    const base = expectedPlanRef ? resolvePlan(aggregate, expectedPlanRef) : null;
    if (base && !agentMapVersionRefsEqual(base.map, expectedMap))
      throw new BuildPlanServiceError("source_mismatch", { currentPlan: aggregate.current.buildPlan,
        affectedIds: [base.versionId], affectedPaths: ["expectedPlan", "expectedMap"], diagnostics: [] });
    const materialized = materializeContent(identity, request, digest);
    const historicalDiagnostics = validateProjectBuildPlanContent(materialized.content, map.graph, activeBriefIds(aggregate));
    if (historicalDiagnostics.some(({ severity }) => severity === "error"))
      throw new BuildPlanServiceError("validation_failed", { currentPlan: aggregate.current.buildPlan,
        affectedIds: [], affectedPaths: historicalDiagnostics.map(({ path }) => path), diagnostics: historicalDiagnostics });
    let content = materialized.content;
    if (base && current && base.versionId !== current.versionId) {
      if (!agentMapVersionRefsEqual(current.map, expectedMap))
        throw new BuildPlanServiceError("source_mismatch", { currentPlan: aggregate.current.buildPlan,
          affectedIds: [current.versionId], affectedPaths: ["expectedMap"], diagnostics: [] });
      const requestedTouches = contentDiff(base.content, materialized.content);
      const interveningTouches = contentDiff(base.content, current.content);
      const overlap = requestedTouches.filter((touch) => interveningTouches.includes(touch));
      if (overlap.length > 0) throw conflict(aggregate, overlap);
      content = mergeContent(base.content, materialized.content, current.content);
      const mergedDiagnostics = validateProjectBuildPlanContent(content, map.graph, activeBriefIds(aggregate));
      if (mergedDiagnostics.some(({ severity }) => severity === "error")) throw conflict(aggregate,
        mergedDiagnostics.map(({ path }) => path), mergedDiagnostics);
    }
    const semanticDigest = computeBuildPlanSemanticDigest(content);
    const same = current !== null && current.semanticDigest === semanticDigest && agentMapVersionRefsEqual(current.map, expectedMap);
    const planId = current?.planId ?? deterministicId("plan", { identity, requestId: request.requestId,
      requestDigest: digest, entityKind: "plan", clientRef: "plan" }) as ProjectBuildPlanId;
    const versionId = deterministicId("planv", { identity, requestId: request.requestId,
      requestDigest: digest, entityKind: "plan-version", clientRef: "version" }) as ProjectBuildPlanVersionId;
    const baseRecord = { schemaVersion: 1 as const, projectId: identity.projectId, planId, versionId,
      version: same ? current.version : (current?.version ?? 0) + 1,
      parentVersionId: same ? current.parentVersionId : current?.versionId ?? null,
      changeKind: (current ? "edited" : "created") as ProjectBuildPlanVersion["changeKind"],
      restoredFromVersionId: null, map: expectedMap, content, semanticDigest,
      authoredBy: { userId: identity.userId, sessionId: identity.sessionId }, createdAt,
      origin: { kind: "request" as const, requestDigest: digest, operationIds: [],
        touchKeys: base ? contentDiff(base.content, materialized.content) : ["plan:create"] } };
    const plan = same ? current : { ...baseRecord, recordDigest: computeBuildPlanRecordDigest(baseRecord) };
    const mappings = [...materialized.mappings];
    if (!current) mappings.unshift({ kind: "plan", clientRef: "plan", id: planId });
    return { plan, mappings, diagnostics: validateProjectBuildPlanContent(content, map.graph, activeBriefIds(aggregate)), noOp: same };
  }

  private prepareRebase(
    identity: ProjectAgentSession,
    aggregate: ProjectPlanningAggregateV2,
    request: BuildPlanRebaseRequest,
    digest: string,
    createdAt: string,
  ): PreparedMutation {
    const current = aggregate.buildPlanVersions.at(-1);
    const expected = { projectId: identity.projectId, ...request.expectedPlan } as ProjectBuildPlanVersionRef;
    if (!current || !projectBuildPlanVersionRefsEqual(refFor(current), expected)) throw conflict(aggregate, ["expectedPlan"]);
    const fromMap = { projectId: identity.projectId, ...request.fromMap } as AgentMapVersionRef;
    const toMap = { projectId: identity.projectId, ...request.toMap } as AgentMapVersionRef;
    if (!agentMapVersionRefsEqual(current.map, fromMap) || !aggregate.current.map ||
      !agentMapVersionRefsEqual(aggregate.current.map, toMap))
      throw new BuildPlanServiceError("source_mismatch", { currentPlan: aggregate.current.buildPlan,
        affectedIds: [request.fromMap.versionId, request.toMap.versionId], affectedPaths: ["fromMap", "toMap"], diagnostics: [] });
    resolveMap(aggregate, fromMap);
    const targetGraph = resolveMap(aggregate, toMap).graph;
    let content = structuredClone(current.content);
    const resolutionKeys = request.resolutions.map((resolution) => resolution.kind === "remap-node"
      ? `node:${resolution.fromNodeId}`
      : resolution.kind === "remove-assignment"
        ? `assignment:${resolution.assignmentId}`
        : resolution.kind === "remove-repository-intent"
          ? `repository:${resolution.repositoryIntentId}`
          : `dependency:${resolution.assignmentId}:${resolution.dependencyId}`);
    if (new Set(resolutionKeys).size !== resolutionKeys.length)
      throw new BuildPlanServiceError("invalid_rebase_resolution", { currentPlan: aggregate.current.buildPlan,
        affectedIds: [], affectedPaths: resolutionKeys.sort(compare), diagnostics: [] });
    const beforeDiagnostics = validateProjectBuildPlanContent(content, targetGraph, activeBriefIds(aggregate));
      const errorPaths = new Set(beforeDiagnostics.filter(({ severity }) => severity === "error").map(({ path }) => path));
    const invalidNodes = new Set<string>();
    beforeDiagnostics.filter(({ severity }) => severity === "error").forEach(({ relatedIds }) => relatedIds.forEach((id) => {
      if (id.startsWith("node_")) invalidNodes.add(id);
    }));
    const used = new Set<number>();
    request.resolutions.forEach((resolution, index) => {
      if (resolution.kind !== "remap-node" || !invalidNodes.has(resolution.fromNodeId)) return;
      if (!targetGraph.nodes.some(({ id }) => id === resolution.toNodeId))
        throw new BuildPlanServiceError("invalid_rebase_resolution", { currentPlan: aggregate.current.buildPlan,
          affectedIds: [resolution.toNodeId], affectedPaths: [`resolutions[${index}].toNodeId`], diagnostics: beforeDiagnostics });
      const remap = (nodeId: string) => nodeId === resolution.fromNodeId ? resolution.toNodeId : nodeId;
      content.assignments = content.assignments.map((assignment) => ({ ...assignment,
        plannedAgentId: remap(assignment.plannedAgentId) as never,
        dependencies: assignment.dependencies.map((dependency) => ({ ...dependency,
          nodeId: remap(dependency.nodeId) as never })) }));
      content.repositoryIntents = content.repositoryIntents.map((intent) => ({ ...intent,
        plannedAgentId: remap(intent.plannedAgentId) as never }));
      used.add(index);
    });
    const interim = validateProjectBuildPlanContent(content, targetGraph, activeBriefIds(aggregate));
    const invalidAssignmentIds = new Set<string>();
    const invalidRepositoryIntentIds = new Set<string>();
    const invalidDependencyKeys = new Set<string>();
    interim.filter(({ severity }) => severity === "error").forEach(({ path }) => {
      const assignment = /^assignments\[(\d+)\]/u.exec(path);
      if (assignment) {
        const assignmentIndex = Number(assignment[1]);
        const assignmentId = content.assignments[assignmentIndex]?.id;
        if (assignmentId) invalidAssignmentIds.add(assignmentId);
        const dependency = /^assignments\[\d+\]\.dependencies\[(\d+)\]$/u.exec(path);
        const dependencyId = dependency
          ? content.assignments[assignmentIndex]?.dependencies[Number(dependency[1])]?.id
          : undefined;
        if (assignmentId && dependencyId)
          invalidDependencyKeys.add(`${assignmentId}:${dependencyId}`);
      }
      const repository = /^repositoryIntents\[(\d+)\]/u.exec(path);
      const repositoryId = repository
        ? content.repositoryIntents[Number(repository[1])]?.id
        : undefined;
      if (repositoryId) invalidRepositoryIntentIds.add(repositoryId);
    });
    request.resolutions.forEach((resolution, index) => {
      if (used.has(index) || resolution.kind === "remap-node") return;
      if (resolution.kind === "remove-assignment") {
        const assignmentIndex = content.assignments.findIndex(({ id }) => id === resolution.assignmentId);
        if (assignmentIndex >= 0 && invalidAssignmentIds.has(resolution.assignmentId)) {
          content = { ...content, assignments: content.assignments.filter((_, item) => item !== assignmentIndex) };
          used.add(index);
        }
      } else if (resolution.kind === "remove-repository-intent") {
        const intentIndex = content.repositoryIntents.findIndex(({ id }) => id === resolution.repositoryIntentId);
        if (intentIndex >= 0 && invalidRepositoryIntentIds.has(resolution.repositoryIntentId)) {
          content = { ...content, repositoryIntents: content.repositoryIntents.filter((_, item) => item !== intentIndex) };
          used.add(index);
        }
      } else {
        const assignmentIndex = content.assignments.findIndex(({ id }) => id === resolution.assignmentId);
        const dependencyIndex = content.assignments[assignmentIndex]?.dependencies.findIndex(({ id }) => id === resolution.dependencyId) ?? -1;
        const relevant = invalidDependencyKeys.has(`${resolution.assignmentId}:${resolution.dependencyId}`);
        if (assignmentIndex >= 0 && dependencyIndex >= 0 && relevant) {
          content = { ...content, assignments: content.assignments.map((assignment, item) => item === assignmentIndex
            ? { ...assignment, dependencies: assignment.dependencies.filter((_, dependencyItem) => dependencyItem !== dependencyIndex) }
            : assignment) };
          used.add(index);
        }
      }
    });
    if (used.size !== request.resolutions.length)
      throw new BuildPlanServiceError("invalid_rebase_resolution", { currentPlan: aggregate.current.buildPlan,
        affectedIds: [], affectedPaths: [...errorPaths].sort(compare), diagnostics: beforeDiagnostics });
    content = parseProjectBuildPlanContent(content);
    const diagnostics = validateProjectBuildPlanContent(content, targetGraph, activeBriefIds(aggregate));
    if (diagnostics.some(({ severity }) => severity === "error"))
      throw new BuildPlanServiceError("rebase_resolution_required", { currentPlan: aggregate.current.buildPlan,
        affectedIds: diagnostics.flatMap(({ relatedIds }) => relatedIds).sort(compare),
        affectedPaths: diagnostics.filter(({ severity }) => severity === "error").map(({ path }) => path), diagnostics });
    const sameSource = agentMapVersionRefsEqual(fromMap, toMap);
    const same = sameSource && computeBuildPlanSemanticDigest(content) === current.semanticDigest;
    const base = { ...current,
      versionId: deterministicId("planv", { identity, requestId: request.requestId, requestDigest: digest,
        entityKind: "plan-version", clientRef: "version" }) as ProjectBuildPlanVersionId,
      version: same ? current.version : current.version + 1,
      parentVersionId: same ? current.parentVersionId : current.versionId,
      changeKind: "rebased" as const, restoredFromVersionId: null, map: toMap, content,
      semanticDigest: computeBuildPlanSemanticDigest(content), authoredBy: { userId: identity.userId, sessionId: identity.sessionId },
      createdAt, origin: { kind: "request" as const, requestDigest: digest, operationIds: [],
        touchKeys: request.resolutions.map((resolution) => canonicalJson(resolution)).sort(compare) } };
    const plan = same ? current : { ...base, recordDigest: computeBuildPlanRecordDigest(base) };
    return { plan, mappings: [], diagnostics, noOp: same };
  }

  private commit(
    identity: ProjectAgentSession,
    aggregate: ProjectPlanningAggregateV2,
    requestId: string,
    digest: string,
    operation: "build_plan_apply" | "build_plan_rebase",
    prepared: PreparedMutation,
  ): Promise<{ value: BuildPlanMutationResult; next: ProjectPlanningAggregateV2 }> {
    if (!prepared.noOp && aggregate.buildPlanVersions.length >= this.versionHistoryLimit)
      throw new BuildPlanServiceError("quota_exceeded");
    const next = structuredClone(aggregate);
    if (!prepared.noOp) {
      next.buildPlanVersions.push(prepared.plan);
      next.current.buildPlan = refFor(prepared.plan);
    }
    const result: BuildPlanMutationResult = { replayed: false, created: !prepared.noOp,
      plan: refFor(prepared.plan), mappings: prepared.mappings, diagnostics: prepared.diagnostics };
    const receipt: ProjectMutationReceipt<BuildPlanMutationResult> = { projectId: identity.projectId,
      userId: identity.userId, sessionId: identity.sessionId, requestId, requestDigest: digest,
      operation, result, createdAt: prepared.plan.createdAt };
    next.requestReceipts.push(receipt);
    const planReceipts = () => next.requestReceipts.filter((entry) =>
      entry.operation === "build_plan_apply" || entry.operation === "build_plan_rebase");
    const expiring = Math.max(0, planReceipts().length - this.receiptRetentionLimit);
    if (next.requestTombstones.length + expiring > PROJECT_MUTATION_TOMBSTONE_LIMIT ||
      next.requestReceipts.length - expiring > PROJECT_MUTATION_RECEIPT_LIMIT)
      throw new BuildPlanServiceError("quota_exceeded");
    for (let count = 0; count < expiring; count += 1) {
      const index = next.requestReceipts.findIndex((entry) =>
        entry.operation === "build_plan_apply" || entry.operation === "build_plan_rebase");
      const [expired] = next.requestReceipts.splice(index, 1);
      if (expired) next.requestTombstones.push({ projectId: expired.projectId, userId: expired.userId,
        sessionId: expired.sessionId, requestId: expired.requestId, operation: expired.operation, createdAt: expired.createdAt });
    }
    next.recordVersion += 1;
    next.updatedAt = prepared.plan.createdAt;
    return Promise.resolve({ value: result, next });
  }

  private replay(
    aggregate: ProjectPlanningAggregateV2,
    identity: ProjectAgentSession,
    requestId: string,
    digest: string,
    operation: "build_plan_apply" | "build_plan_rebase",
  ): BuildPlanMutationResult | null {
    const matches = (entry: { userId: string; sessionId: string; requestId: string }) =>
      entry.userId === identity.userId && entry.sessionId === identity.sessionId && entry.requestId === requestId;
    const receipt = aggregate.requestReceipts.find(matches);
    if (receipt) {
      if (receipt.operation !== operation || receipt.requestDigest !== digest)
        throw new BuildPlanServiceError("request_id_reused", { currentPlan: aggregate.current.buildPlan,
          affectedIds: [], affectedPaths: [], diagnostics: [] });
      return { ...(structuredClone(receipt.result) as BuildPlanMutationResult), replayed: true };
    }
    if (aggregate.requestTombstones.some(matches))
      throw new BuildPlanServiceError("request_id_expired", { currentPlan: aggregate.current.buildPlan,
        affectedIds: [], affectedPaths: [], diagnostics: [] });
    return null;
  }

  private versionOf(result: BuildPlanMutationResult, aggregate: ProjectPlanningAggregateV2): number | null {
    return aggregate.buildPlanVersions.find(({ versionId }) => versionId === result.plan.versionId)?.version ??
      (aggregate.buildPlanVersions.at(-1)?.version ?? 0) + (result.created ? 1 : 0);
  }

  private emit(
    identity: ProjectAgentSession,
    operation: Parameters<NonNullable<BuildPlanServiceOptions["onOutcome"]>>[0]["operation"],
    outcome: Parameters<NonNullable<BuildPlanServiceOptions["onOutcome"]>>[0]["outcome"],
    version: number | null,
    diagnosticCount: number,
    affectedCount: number,
  ): void {
    try { void Promise.resolve(this.options.onOutcome?.({ operation, outcome, projectId: identity.projectId,
      sessionId: identity.sessionId, version, diagnosticCount, affectedCount })).catch(() => {}); }
    catch { /* telemetry never changes plan behavior */ }
  }
}
