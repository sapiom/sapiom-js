import type {
  AgentMapVersion,
  MapChangeProposal,
  ProposalOperationId,
  RoleNeutralMapOperationRecord,
  StudioProjectId,
} from "../shared/agent-map.js";
import {
  parseAgentMapProposalReceipt,
  parseAgentMapVersion,
  parseMapChangeProposal,
  parseMapOperation,
  parseLegacyE2ProposalActor,
  parseProjectAgentActorRef,
  type PersistedAgentMapProposalReceipt,
} from "../shared/agent-map-codec.js";
import { canonicalDigest, canonicalJson } from "../shared/agent-map-canonical.js";
import type {
  AgentBriefVersion,
  AgentBriefHistoryPointer,
  BuildPlanCurrentPointers,
  ProjectBuildPlanVersion,
  ProjectMutationReceipt,
  ProjectMutationTombstone,
} from "../shared/build-plan.js";
import {
  AGENT_BRIEF_VERSION_HISTORY_LIMIT,
  BUILD_PLAN_VERSION_HISTORY_LIMIT,
  PROJECT_MUTATION_RECEIPT_LIMIT,
  PROJECT_MUTATION_TOMBSTONE_LIMIT,
  PROJECT_PLANNING_STORAGE_SCHEMA_VERSION,
} from "../shared/build-plan.js";
import {
  parseAgentBriefVersion,
  parseBuildPlanCurrentPointers,
  parseProjectBuildPlanVersion,
} from "../shared/build-plan-codec.js";
import {
  agentMapVersionRef,
  applyPersistedMapOperations,
  createAgentMapVersion,
  deterministicVersionId,
  validateAgentMapVersionHistory,
} from "./agent-map-version.js";
import { derivePersistedMapOperationTouchSet } from "./agent-map-proposal-validator.js";
import { isStudioProjectId } from "./studio-project-catalog.js";

export const AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION = PROJECT_PLANNING_STORAGE_SCHEMA_VERSION;

export interface ProjectPlanningAggregateV2 {
  storageSchemaVersion: typeof PROJECT_PLANNING_STORAGE_SCHEMA_VERSION;
  projectId: StudioProjectId;
  recordVersion: number;
  current: {
    map: BuildPlanCurrentPointers["map"];
    buildPlan: BuildPlanCurrentPointers["buildPlan"];
    briefsByScope: Record<string, AgentBriefHistoryPointer>;
  };
  mapVersions: AgentMapVersion[];
  buildPlanVersions: ProjectBuildPlanVersion[];
  briefVersionsById: Record<string, AgentBriefVersion[]>;
  mapOperationHistory: RoleNeutralMapOperationRecord[];
  requestReceipts: ProjectMutationReceipt[];
  requestTombstones: ProjectMutationTombstone[];
  createdAt: string;
  updatedAt: string;
  aggregateDigest: string;
}

export type AgentMapProjectAggregate = ProjectPlanningAggregateV2;

export class AgentMapAggregateError extends Error {
  constructor(
    readonly code: "malformed_state" | "unsupported_schema",
    readonly schemaVersion?: number,
  ) {
    super(code === "unsupported_schema" ? "Agent Map state uses an unsupported schema" : "Agent Map state is malformed");
    this.name = "AgentMapAggregateError";
  }
}

function malformed(): never {
  throw new AgentMapAggregateError("malformed_state");
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const bounded = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value &&
  !value.includes("/") && !value.includes("\\") && ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
const requestDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
const rejectFutureNestedVersion = (value: unknown): void => {
  if (isRecord(value) && Number.isSafeInteger(value.schemaVersion) && (value.schemaVersion as number) > 1)
    throw new AgentMapAggregateError("unsupported_schema", value.schemaVersion as number);
};

export interface LegacyWorkspaceState {
  projectId: StudioProjectId;
  schemaVersion: 1;
  recordVersion: number;
  confirmedRevisionId: string | null;
  activeProposalId: string | null;
  projectBuildPlanId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function parseLegacyWorkspaceState(value: unknown, projectId: StudioProjectId): LegacyWorkspaceState {
  if (isRecord(value) && Number.isSafeInteger(value.schemaVersion) && (value.schemaVersion as number) > 1)
    throw new AgentMapAggregateError("unsupported_schema", value.schemaVersion as number);
  if (!isRecord(value) || !exact(value, ["projectId", "schemaVersion", "recordVersion", "confirmedRevisionId",
    "activeProposalId", "projectBuildPlanId", "createdAt", "updatedAt"]) || value.projectId !== projectId ||
    value.schemaVersion !== 1 || !Number.isSafeInteger(value.recordVersion) || (value.recordVersion as number) < 1 ||
    ![value.confirmedRevisionId, value.activeProposalId, value.projectBuildPlanId].every((entry) => entry === null || bounded(entry)) ||
    !timestamp(value.createdAt) || !timestamp(value.updatedAt)) malformed();
  return structuredClone(value) as unknown as LegacyWorkspaceState;
}

export const computeProjectPlanningAggregateDigest = (
  aggregate: Omit<ProjectPlanningAggregateV2, "aggregateDigest"> | ProjectPlanningAggregateV2,
): string => canonicalDigest(
  "sapiom.project-planning.aggregate.v2",
  Object.fromEntries(Object.entries(aggregate).filter(([key]) => key !== "aggregateDigest")),
);

export function createEmptyProjectPlanningAggregate(
  projectId: StudioProjectId,
  createdAt: string,
  recordVersion = 1,
): ProjectPlanningAggregateV2 {
  const base: Omit<ProjectPlanningAggregateV2, "aggregateDigest"> = {
    storageSchemaVersion: PROJECT_PLANNING_STORAGE_SCHEMA_VERSION,
    projectId,
    recordVersion,
    current: { map: null, buildPlan: null, briefsByScope: {} },
    mapVersions: [],
    buildPlanVersions: [],
    briefVersionsById: {},
    mapOperationHistory: [],
    requestReceipts: [],
    requestTombstones: [],
    createdAt,
    updatedAt: createdAt,
  };
  return { ...base, aggregateDigest: computeProjectPlanningAggregateDigest(base) };
}

function refsEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validatePlanHistory(aggregate: ProjectPlanningAggregateV2): void {
  const mapById = new Map(aggregate.mapVersions.map((version) => [version.versionId, version]));
  const planIds = new Set<string>();
  aggregate.buildPlanVersions.forEach((version, index) => {
    if (version.projectId !== aggregate.projectId || version.version !== index + 1 ||
      version.parentVersionId !== (aggregate.buildPlanVersions[index - 1]?.versionId ?? null) || planIds.has(version.versionId)) malformed();
    parseProjectBuildPlanVersion(version, aggregate.projectId);
    const map = mapById.get(version.map.versionId);
    if (!map || !refsEqual(agentMapVersionRef(map), version.map)) malformed();
    if (version.changeKind === "restored" && !planIds.has(version.restoredFromVersionId ?? "")) malformed();
    planIds.add(version.versionId);
  });
  const tail = aggregate.buildPlanVersions.at(-1);
  if (!refsEqual(aggregate.current.buildPlan, tail ? {
    projectId: tail.projectId, planId: tail.planId, versionId: tail.versionId, semanticDigest: tail.semanticDigest,
  } : null)) malformed();
  if (new Set(aggregate.buildPlanVersions.map(({ planId }) => planId)).size > 1) malformed();
}

function validateBriefHistories(aggregate: ProjectPlanningAggregateV2): void {
  const planById = new Map(aggregate.buildPlanVersions.map((version) => [version.versionId, version]));
  const mapById = new Map(aggregate.mapVersions.map((version) => [version.versionId, version]));
  for (const [briefId, versions] of Object.entries(aggregate.briefVersionsById)) {
    if (versions.length === 0 || versions.length > AGENT_BRIEF_VERSION_HISTORY_LIMIT) malformed();
    const ids = new Set<string>();
    versions.forEach((version, index) => {
      if (version.briefId !== briefId || version.projectId !== aggregate.projectId || version.version !== index + 1 ||
        version.parentVersionId !== (versions[index - 1]?.versionId ?? null) || ids.has(version.versionId)) malformed();
      parseAgentBriefVersion(version, aggregate.projectId);
      const map = mapById.get(version.map.versionId);
      const plan = planById.get(version.plan.versionId);
      if (!map || !plan || !refsEqual(agentMapVersionRef(map), version.map) ||
        !refsEqual({ projectId: plan.projectId, planId: plan.planId, versionId: plan.versionId, semanticDigest: plan.semanticDigest }, version.plan) ||
        (version.changeKind === "restored" && !ids.has(version.restoredFromVersionId ?? ""))) malformed();
      ids.add(version.versionId);
    });
  }
  const seenBriefIds = new Set<string>();
  for (const [scopeKey, pointer] of Object.entries(aggregate.current.briefsByScope)) {
    const versions = aggregate.briefVersionsById[pointer.briefId];
    if (pointer.scopeKey !== scopeKey || !versions?.length || seenBriefIds.has(pointer.briefId) ||
      !refsEqual(pointer.version, (() => { const tail = versions.at(-1)!; return { projectId: tail.projectId, briefId: tail.briefId, versionId: tail.versionId, semanticDigest: tail.semanticDigest }; })()) ||
      versions.some((version) => version.scopeKey !== scopeKey || !refsEqual(version.focusScope, pointer.focusScope))) malformed();
    seenBriefIds.add(pointer.briefId);
  }
  if (Object.keys(aggregate.briefVersionsById).some((briefId) => !seenBriefIds.has(briefId))) malformed();
}

function parseMapOperationHistory(value: unknown): RoleNeutralMapOperationRecord[] {
  if (!Array.isArray(value) || value.length > 65_536) malformed();
  return value.map((entry) => {
    if (!isRecord(entry) || !exact(entry, ["id", "requestId", "acceptedVersion", "operation", "actor", "acceptedAt"]) ||
      !bounded(entry.id) || !bounded(entry.requestId, 128) || !Number.isSafeInteger(entry.acceptedVersion) ||
      (entry.acceptedVersion as number) < 1 || !timestamp(entry.acceptedAt)) malformed();
    try {
      return { id: entry.id as ProposalOperationId, requestId: entry.requestId,
        acceptedVersion: entry.acceptedVersion as number, operation: parseMapOperation(entry.operation),
        actor: parseProjectAgentActorRef(entry.actor), acceptedAt: entry.acceptedAt };
    } catch { return malformed(); }
  });
}

function parseReceipt(value: unknown, projectId: StudioProjectId): ProjectMutationReceipt {
  if (!isRecord(value) || !exact(value, ["projectId", "userId", "sessionId", "requestId", "requestDigest", "operation", "result", "createdAt"]) ||
    value.projectId !== projectId || !bounded(value.userId) || !bounded(value.sessionId) || !bounded(value.requestId, 128) ||
    !requestDigest(value.requestDigest) || !["map", "build_plan_apply", "build_plan_rebase", "map_restore", "plan_restore", "brief_append"].includes(String(value.operation)) ||
    !timestamp(value.createdAt)) malformed();
  try { canonicalJson(value.result); } catch { malformed(); }
  return structuredClone(value) as unknown as ProjectMutationReceipt;
}

function parseTombstone(value: unknown, projectId: StudioProjectId): ProjectMutationTombstone {
  if (!isRecord(value) || !exact(value, ["projectId", "userId", "sessionId", "requestId", "operation", "createdAt"]) ||
    value.projectId !== projectId || !bounded(value.userId) || !bounded(value.sessionId) || !bounded(value.requestId, 128) ||
    !["map", "build_plan_apply", "build_plan_rebase", "map_restore", "plan_restore", "brief_append"].includes(String(value.operation)) ||
    !timestamp(value.createdAt)) malformed();
  return structuredClone(value) as unknown as ProjectMutationTombstone;
}

export function parseProjectPlanningAggregate(value: unknown, projectId: StudioProjectId): ProjectPlanningAggregateV2 {
  if (isRecord(value) && Number.isSafeInteger(value.storageSchemaVersion) &&
    (value.storageSchemaVersion as number) > PROJECT_PLANNING_STORAGE_SCHEMA_VERSION)
    throw new AgentMapAggregateError("unsupported_schema", value.storageSchemaVersion as number);
  if (!isRecord(value) || !exact(value, ["storageSchemaVersion", "projectId", "recordVersion", "current", "mapVersions",
    "buildPlanVersions", "briefVersionsById", "mapOperationHistory", "requestReceipts", "requestTombstones",
    "createdAt", "updatedAt", "aggregateDigest"]) || value.storageSchemaVersion !== PROJECT_PLANNING_STORAGE_SCHEMA_VERSION ||
    value.projectId !== projectId || !isStudioProjectId(value.projectId) || !Number.isSafeInteger(value.recordVersion) ||
    (value.recordVersion as number) < 1 || !Array.isArray(value.mapVersions) || !Array.isArray(value.buildPlanVersions) ||
    !isRecord(value.briefVersionsById) || !Array.isArray(value.requestReceipts) || !Array.isArray(value.requestTombstones) ||
    !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !requestDigest(value.aggregateDigest)) malformed();
  if (value.mapVersions.length > BUILD_PLAN_VERSION_HISTORY_LIMIT || value.buildPlanVersions.length > BUILD_PLAN_VERSION_HISTORY_LIMIT ||
    value.requestReceipts.length > PROJECT_MUTATION_RECEIPT_LIMIT || value.requestTombstones.length > PROJECT_MUTATION_TOMBSTONE_LIMIT) malformed();
  let current: ProjectPlanningAggregateV2["current"];
  let mapVersions: AgentMapVersion[];
  let buildPlanVersions: ProjectBuildPlanVersion[];
  let briefVersionsById: Record<string, AgentBriefVersion[]>;
  try {
    const parsedCurrent = parseBuildPlanCurrentPointers(value.current, projectId);
    current = { ...parsedCurrent, briefsByScope: structuredClone(parsedCurrent.briefsByScope) };
    mapVersions = value.mapVersions.map((version) => {
      rejectFutureNestedVersion(version);
      return parseAgentMapVersion(version, projectId);
    });
    buildPlanVersions = value.buildPlanVersions.map((version) => {
      rejectFutureNestedVersion(version);
      return parseProjectBuildPlanVersion(version, projectId);
    });
    briefVersionsById = Object.fromEntries(Object.entries(value.briefVersionsById).map(([briefId, versions]) => {
      if (!Array.isArray(versions)) malformed();
      return [briefId, versions.map((version) => {
        rejectFutureNestedVersion(version);
        return parseAgentBriefVersion(version, projectId);
      })];
    }));
  } catch (error) {
    if (error instanceof AgentMapAggregateError) throw error;
    return malformed();
  }
  const aggregate: ProjectPlanningAggregateV2 = {
    storageSchemaVersion: PROJECT_PLANNING_STORAGE_SCHEMA_VERSION, projectId, recordVersion: value.recordVersion as number,
    current, mapVersions, buildPlanVersions, briefVersionsById,
    mapOperationHistory: parseMapOperationHistory(value.mapOperationHistory),
    requestReceipts: value.requestReceipts.map((receipt) => parseReceipt(receipt, projectId)),
    requestTombstones: value.requestTombstones.map((tombstone) => parseTombstone(tombstone, projectId)),
    createdAt: value.createdAt, updatedAt: value.updatedAt, aggregateDigest: value.aggregateDigest,
  };
  try { validateAgentMapVersionHistory(aggregate.mapVersions, projectId); } catch { malformed(); }
  validateMapOperationHistory(aggregate);
  const mapTail = aggregate.mapVersions.at(-1);
  if (!refsEqual(aggregate.current.map, mapTail ? agentMapVersionRef(mapTail) : null)) malformed();
  validatePlanHistory(aggregate);
  validateBriefHistories(aggregate);
  const keys = (entry: { userId: string; sessionId: string; requestId: string }) => `${entry.userId}\0${entry.sessionId}\0${entry.requestId}`;
  const receiptKeys = aggregate.requestReceipts.map(keys);
  const tombstoneKeys = aggregate.requestTombstones.map(keys);
  if (new Set(receiptKeys).size !== receiptKeys.length || new Set(tombstoneKeys).size !== tombstoneKeys.length ||
    tombstoneKeys.some((key) => receiptKeys.includes(key)) || computeProjectPlanningAggregateDigest(aggregate) !== aggregate.aggregateDigest) malformed();
  return structuredClone(aggregate);
}

function validateMapOperationHistory(aggregate: ProjectPlanningAggregateV2): void {
  const operationIds = new Set<string>();
  const batches = new Map<number, RoleNeutralMapOperationRecord[]>();
  for (const record of aggregate.mapOperationHistory) {
    if (operationIds.has(record.id)) malformed();
    operationIds.add(record.id);
    const batch = batches.get(record.acceptedVersion) ?? [];
    batch.push(record);
    batches.set(record.acceptedVersion, batch);
  }
  let graph: AgentMapVersion["graph"] = { nodes: [], relationships: [] };
  let acceptedVersion = 0;
  let semanticVersion = 0;
  for (const [version, records] of batches) {
    if (version !== ++acceptedVersion || records.length === 0) malformed();
    const first = records[0]!;
    if (records.some((record) =>
      record.requestId !== first.requestId ||
      record.acceptedAt !== first.acceptedAt ||
      !refsEqual(record.actor, first.actor)
    )) malformed();
    const before = graph;
    try {
      graph = applyPersistedMapOperations(graph, records.map(({ operation }) => operation));
    } catch {
      malformed();
    }
    if (canonicalJson(before) === canonicalJson(graph)) continue;
    const immutable = aggregate.mapVersions[semanticVersion++];
    if (!immutable ||
      !refsEqual(immutable.graph, graph) ||
      !refsEqual(immutable.authoredBy, first.actor) ||
      immutable.createdAt !== first.acceptedAt ||
      !refsEqual(immutable.origin.operationIds, records.map(({ id }) => id)) ||
      (immutable.origin.kind === "migration" && immutable.origin.legacyAcceptedVersion !== version)) malformed();
  }
  // Restoration records may follow operation-authored versions, but an
  // operation-authored record may never be detached from its accepted batch.
  if (aggregate.mapVersions.slice(semanticVersion).some(({ changeKind }) => changeKind !== "restored")) malformed();
}

function legacyE2(value: unknown, projectId: StudioProjectId): {
  workspace: LegacyWorkspaceState;
  proposal: MapChangeProposal | null;
  receipts: PersistedAgentMapProposalReceipt[];
} {
  if (!isRecord(value) || !exact(value, ["storageSchemaVersion", "workspace", "proposal", "receipts"]) ||
    value.storageSchemaVersion !== 1 || !Array.isArray(value.receipts)) malformed();
  const workspace = parseLegacyWorkspaceState(value.workspace, projectId);
  if (workspace.confirmedRevisionId !== null || workspace.projectBuildPlanId !== null ||
    (value.proposal === null) !== (workspace.activeProposalId === null)) malformed();
  let proposal: MapChangeProposal | null;
  try {
    if (value.proposal === null) proposal = null;
    else {
      rejectFutureNestedVersion(value.proposal);
      if (!isRecord(value.proposal) || !Array.isArray(value.proposal.history)) malformed();
      const neutralHistory = value.proposal.history.map((record) => {
        if (!isRecord(record)) malformed();
        const actor = parseLegacyE2ProposalActor(record.actor);
        return { ...record, actor: { userId: actor.userId, sessionId: actor.sessionId } };
      });
      proposal = parseMapChangeProposal({ ...value.proposal, history: neutralHistory }, projectId, workspace.activeProposalId ?? undefined);
    }
  } catch { return malformed(); }
  if (proposal?.baseRevisionId !== null) malformed();
  const receipts = value.receipts.map((receipt) => {
    try { return parseAgentMapProposalReceipt(receipt); } catch { return malformed(); }
  });
  return { workspace, proposal, receipts };
}

function migrateE2(value: unknown, projectId: StudioProjectId): ProjectPlanningAggregateV2 {
  const legacy = legacyE2(value, projectId);
  let graph = { nodes: [], relationships: [] } as { nodes: AgentMapVersion["graph"]["nodes"]; relationships: AgentMapVersion["graph"]["relationships"] };
  const mapVersions: AgentMapVersion[] = [];
  const mapOperationHistory: RoleNeutralMapOperationRecord[] = [];
  const batches = new Map<number, MapChangeProposal["history"]>();
  for (const record of legacy.proposal?.history ?? []) {
    const list = batches.get(record.acceptedVersion) ?? [];
    batches.set(record.acceptedVersion, [...list, record]);
  }
  let expectedAcceptedVersion = 1;
  for (const [acceptedVersion, records] of batches) {
    if (acceptedVersion !== expectedAcceptedVersion++ || records.length === 0) malformed();
    const first = records[0]!;
    if (records.some((record) => record.requestId !== first.requestId ||
      record.acceptedAt !== first.acceptedAt || canonicalJson(record.actor) !== canonicalJson(first.actor))) malformed();
    const before = graph;
    try { graph = applyPersistedMapOperations(graph, records.map(({ operation }) => operation)); } catch { malformed(); }
    const actor = { userId: first.actor.userId, sessionId: first.actor.sessionId };
    mapOperationHistory.push(...records.map((record) => ({ id: record.id, requestId: record.requestId,
      acceptedVersion: record.acceptedVersion, operation: record.operation, actor, acceptedAt: record.acceptedAt })));
    const contentChanged = canonicalJson(before) !== canonicalJson(graph);
    if (contentChanged) {
      const contentDigest = canonicalDigest("sapiom.agent-map.content.v1", graph);
      const touch = derivePersistedMapOperationTouchSet(before, records.map(({ operation }) => operation), graph);
      const retained = legacy.receipts.find((receipt) => receipt.version === acceptedVersion &&
        receipt.sessionId === actor.sessionId && receipt.requestId === first.requestId);
      const origin = {
        kind: "migration" as const,
        requestDigest: retained ? `sha256:${retained.requestDigest}` : canonicalDigest("sapiom.agent-map.migrated-request.v1", records.map(({ operation }) => operation)),
        operationIds: records.map(({ id }) => id),
        touchKeys: [...touch.entityKeys.map((key) => `entity:${key}`),
          ...touch.semanticRelationshipKeys.map((key) => `semantic:${key}`)].sort(),
        legacyProposalId: legacy.proposal?.id ?? null,
        legacyAcceptedVersion: acceptedVersion,
      };
      mapVersions.push(createAgentMapVersion({ projectId,
        versionId: deterministicVersionId("mapv", [projectId, legacy.proposal?.id ?? "empty", String(acceptedVersion), contentDigest]) as AgentMapVersion["versionId"],
        version: mapVersions.length + 1, parentVersionId: mapVersions.at(-1)?.versionId ?? null,
        graph, changeKind: "migrated", restoredFromVersionId: null, authoredBy: actor, createdAt: first.acceptedAt, origin }));
    }
  }
  if (legacy.proposal && canonicalJson(graph) !== canonicalJson({ nodes: legacy.proposal.nodes, relationships: legacy.proposal.relationships })) malformed();
  const retainedVersions = new Set<number>();
  const requestReceipts: ProjectMutationReceipt[] = legacy.receipts.map((receipt) => {
    if (retainedVersions.has(receipt.version)) return malformed();
    retainedVersions.add(receipt.version);
    const records = legacy.proposal?.history.filter(({ acceptedVersion }) => acceptedVersion === receipt.version) ?? [];
    const first = records[0];
    if (!first || first.actor.sessionId !== receipt.sessionId || records.some(({ requestId }) => requestId !== receipt.requestId)) return malformed();
    const addedNodeIds = records.flatMap(({ operation }) => operation.kind === "add-node" ? [operation.node.id] : []);
    const addedRelationshipIds = records.flatMap(({ operation }) => operation.kind === "add-relationship" ? [operation.relationship.id] : []);
    if (!refsEqual(Object.values(receipt.allocatedNodeIds).sort(), [...addedNodeIds].sort()) ||
      !refsEqual(Object.values(receipt.allocatedRelationshipIds).sort(), [...addedRelationshipIds].sort())) return malformed();
    const actor = { userId: first.actor.userId, sessionId: first.actor.sessionId };
    const operations = records.map(({ operation }) => operation);
    const operationIds = records.map(({ id }) => id);
    const acceptedAt = first.acceptedAt;
    const delta = {
      schemaVersion: 1 as const,
      projectId,
      proposalId: legacy.proposal!.id,
      fromVersion: receipt.version - 1,
      version: receipt.version,
      operationIds,
      operations,
      actor,
      acceptedAt,
    };
    return { projectId, userId: first.actor.userId, sessionId: receipt.sessionId, requestId: receipt.requestId,
      requestDigest: `sha256:${receipt.requestDigest}`, operation: "map", createdAt: first.acceptedAt,
      result: { schemaVersion: 1 as const, proposalId: legacy.proposal!.id, version: receipt.version,
        operationIds, allocatedNodeIds: receipt.allocatedNodeIds,
        allocatedRelationshipIds: receipt.allocatedRelationshipIds, delta } };
  });
  const receiptKeys = new Set(requestReceipts.map(({ sessionId, requestId }) => `${sessionId}\0${requestId}`));
  const requestTombstones: ProjectMutationTombstone[] = [];
  for (const record of legacy.proposal?.history ?? []) {
    const key = `${record.actor.sessionId}\0${record.requestId}`;
    if (!receiptKeys.has(key) && !requestTombstones.some((entry) => `${entry.sessionId}\0${entry.requestId}` === key))
      requestTombstones.push({ projectId, userId: record.actor.userId, sessionId: record.actor.sessionId,
        requestId: record.requestId, operation: "map", createdAt: record.acceptedAt });
  }
  const base: Omit<ProjectPlanningAggregateV2, "aggregateDigest"> = { storageSchemaVersion: PROJECT_PLANNING_STORAGE_SCHEMA_VERSION, projectId,
    recordVersion: legacy.workspace.recordVersion,
    current: { map: mapVersions.at(-1) ? agentMapVersionRef(mapVersions.at(-1)!) : null, buildPlan: null, briefsByScope: {} },
    mapVersions, buildPlanVersions: [], briefVersionsById: {}, mapOperationHistory,
    requestReceipts, requestTombstones, createdAt: legacy.workspace.createdAt, updatedAt: legacy.workspace.updatedAt };
  return parseProjectPlanningAggregate({ ...base, aggregateDigest: computeProjectPlanningAggregateDigest(base) }, projectId);
}

export function migrateProjectPlanningAggregate(
  value: unknown,
  projectId: StudioProjectId,
): { aggregate: ProjectPlanningAggregateV2; migrated: boolean } {
  if (!isStudioProjectId(projectId)) malformed();
  if (isRecord(value) && "storageSchemaVersion" in value) {
    if (!Number.isSafeInteger(value.storageSchemaVersion) || (value.storageSchemaVersion as number) < 1) malformed();
    if ((value.storageSchemaVersion as number) > PROJECT_PLANNING_STORAGE_SCHEMA_VERSION)
      throw new AgentMapAggregateError("unsupported_schema", value.storageSchemaVersion as number);
    if (value.storageSchemaVersion === PROJECT_PLANNING_STORAGE_SCHEMA_VERSION)
      return { aggregate: parseProjectPlanningAggregate(value, projectId), migrated: false };
    return { aggregate: migrateE2(value, projectId), migrated: true };
  }
  const workspace = parseLegacyWorkspaceState(value, projectId);
  if (workspace.confirmedRevisionId !== null || workspace.activeProposalId !== null || workspace.projectBuildPlanId !== null) malformed();
  const aggregate = createEmptyProjectPlanningAggregate(projectId, workspace.createdAt, workspace.recordVersion);
  aggregate.updatedAt = workspace.updatedAt;
  aggregate.aggregateDigest = computeProjectPlanningAggregateDigest(aggregate);
  return { aggregate: parseProjectPlanningAggregate(aggregate, projectId), migrated: true };
}
