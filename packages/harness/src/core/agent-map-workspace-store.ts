import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AGENT_MAP_INITIAL_RECORD_VERSION,
  AGENT_MAP_WORKSPACE_SCHEMA_VERSION,
  type AgentMapErrorCode,
  type AgentMapWorkspaceState,
  type MapChangeProposal,
  type StudioProjectId,
} from "../shared/agent-map.js";
import {
  parseAgentMapProposalReceipt,
  parseMapChangeProposal,
  type PersistedAgentMapProposalReceipt,
} from "../shared/agent-map-codec.js";
import {
  emptyBuildPlanningAggregate,
  type BuildPlanningAggregateV1,
} from "../shared/build-plan.js";
import { parseBuildPlanningAggregate } from "../shared/build-plan-codec.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
  computePlanningAssignmentRecordDigest,
  computePlanningSubmissionRecordDigest,
  computePlanningSubmissionSemanticDigest,
} from "./build-plan-canonicalization.js";
import { DurableFileLock } from "./durable-file-lock.js";
import { isStudioProjectId } from "./studio-project-catalog.js";

export const AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION = 2;

export type AgentMapProposalReceipt = PersistedAgentMapProposalReceipt;

export interface AgentMapProjectAggregate {
  storageSchemaVersion: typeof AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION;
  workspace: AgentMapWorkspaceState;
  proposal: MapChangeProposal | null;
  receipts: AgentMapProposalReceipt[];
  buildPlanning: BuildPlanningAggregateV1;
}

export interface AgentMapStoreSnapshot {
  workspace: AgentMapWorkspaceState;
  proposal: MapChangeProposal | null;
}

export type AgentMapWorkspaceStoreEvent =
  | { name: "agent_map.workspace_initialized"; projectId: StudioProjectId }
  | {
      name: "agent_map.workspace_read_failed";
      projectId: StudioProjectId;
      schemaVersion?: number;
      errorCode: Exclude<AgentMapErrorCode, "project_not_found">;
    };

export class AgentMapWorkspaceStoreError extends Error {
  constructor(
    readonly code: Exclude<AgentMapErrorCode, "project_not_found">,
    readonly schemaVersion?: number,
  ) {
    super(
      code === "unsupported_schema"
        ? "Agent Map state uses an unsupported schema"
        : code === "malformed_state"
          ? "Agent Map state is malformed"
          : "Agent Map storage is unavailable",
    );
    this.name = "AgentMapWorkspaceStoreError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const isTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const isOpaqueId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes(":") &&
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const nullableOpaqueId = (value: unknown): value is string | null =>
  value === null || isOpaqueId(value);

export function parseAgentMapWorkspaceState(
  value: unknown,
  expectedProjectId: StudioProjectId,
): AgentMapWorkspaceState {
  const schemaVersion =
    isRecord(value) && Number.isSafeInteger(value.schemaVersion)
      ? (value.schemaVersion as number)
      : undefined;
  if (
    schemaVersion !== undefined &&
    schemaVersion > AGENT_MAP_WORKSPACE_SCHEMA_VERSION
  ) {
    throw new AgentMapWorkspaceStoreError("unsupported_schema", schemaVersion);
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "projectId",
      "schemaVersion",
      "recordVersion",
      "confirmedRevisionId",
      "activeProposalId",
      "projectBuildPlanId",
      "createdAt",
      "updatedAt",
    ]) ||
    value.projectId !== expectedProjectId ||
    !isStudioProjectId(value.projectId) ||
    value.schemaVersion !== AGENT_MAP_WORKSPACE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.recordVersion) ||
    (value.recordVersion as number) < 1 ||
    !nullableOpaqueId(value.confirmedRevisionId) ||
    !nullableOpaqueId(value.activeProposalId) ||
    !nullableOpaqueId(value.projectBuildPlanId) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  )
    throw new AgentMapWorkspaceStoreError("malformed_state", schemaVersion);
  return value as unknown as AgentMapWorkspaceState;
}

const storageError = () =>
  new AgentMapWorkspaceStoreError("storage_unavailable");

function parseArchitectureFields(
  value: unknown,
  projectId: StudioProjectId,
): Pick<AgentMapProjectAggregate, "workspace" | "proposal" | "receipts"> {
  if (!isRecord(value) || !Array.isArray(value.receipts))
    throw new AgentMapWorkspaceStoreError("malformed_state");
  const workspace = parseAgentMapWorkspaceState(value.workspace, projectId);
  let proposal: MapChangeProposal | null = null;
  if ((value.proposal === null) !== (workspace.activeProposalId === null))
    throw new AgentMapWorkspaceStoreError("malformed_state");
  if (value.proposal !== null && workspace.activeProposalId !== null) {
    try {
      proposal = parseMapChangeProposal(
        value.proposal,
        projectId,
        workspace.activeProposalId,
      );
    } catch {
      throw new AgentMapWorkspaceStoreError("malformed_state");
    }
  }
  const receipts: AgentMapProposalReceipt[] = [];
  for (const receipt of value.receipts) {
    let parsed: AgentMapProposalReceipt;
    try {
      parsed = parseAgentMapProposalReceipt(receipt);
    } catch {
      throw new AgentMapWorkspaceStoreError("malformed_state");
    }
    const records =
      proposal?.history.filter(
        ({ acceptedVersion }) => acceptedVersion === parsed.version,
      ) ?? [];
    const actor = records[0]?.actor;
    const acceptedAt = records[0]?.acceptedAt;
    const allocatedNodeIds = records.flatMap(({ operation }) =>
      operation.kind === "add-node" ? [operation.node.id] : [],
    );
    const allocatedRelationshipIds = records.flatMap(({ operation }) =>
      operation.kind === "add-relationship" ? [operation.relationship.id] : [],
    );
    if (
      proposal === null ||
      parsed.version > proposal.version ||
      records.length === 0 ||
      records.some(
        (record) =>
          record.requestId !== parsed.requestId ||
          record.actor.sessionId !== parsed.sessionId ||
          JSON.stringify(record.actor) !== JSON.stringify(actor) ||
          record.acceptedAt !== acceptedAt,
      ) ||
      JSON.stringify(Object.values(parsed.allocatedNodeIds).sort()) !==
        JSON.stringify(allocatedNodeIds.sort()) ||
      JSON.stringify(Object.values(parsed.allocatedRelationshipIds).sort()) !==
        JSON.stringify(allocatedRelationshipIds.sort())
    )
      throw new AgentMapWorkspaceStoreError("malformed_state");
    receipts.push(parsed);
  }
  if (
    new Set(
      receipts.map(({ sessionId, requestId }) => `${sessionId}\0${requestId}`),
    ).size !== receipts.length
  )
    throw new AgentMapWorkspaceStoreError("malformed_state");
  return { workspace, proposal, receipts };
}

function parseAggregate(
  value: unknown,
  projectId: StudioProjectId,
): AgentMapProjectAggregate {
  if (
    isRecord(value) &&
    Number.isSafeInteger(value.storageSchemaVersion) &&
    (value.storageSchemaVersion as number) >
      AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION
  )
    throw new AgentMapWorkspaceStoreError(
      "unsupported_schema",
      value.storageSchemaVersion as number,
    );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "storageSchemaVersion",
      "workspace",
      "proposal",
      "receipts",
      "buildPlanning",
    ]) ||
    value.storageSchemaVersion !== AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION
  )
    throw new AgentMapWorkspaceStoreError("malformed_state");
  const architecture = parseArchitectureFields(value, projectId);
  let buildPlanning: BuildPlanningAggregateV1;
  try {
    buildPlanning = parseBuildPlanningAggregate(value.buildPlanning, projectId);
  } catch {
    throw new AgentMapWorkspaceStoreError("malformed_state");
  }
  if (architecture.workspace.projectBuildPlanId !== buildPlanning.planId)
    throw new AgentMapWorkspaceStoreError("malformed_state");
  return structuredClone({
    storageSchemaVersion: AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION,
    ...architecture,
    buildPlanning,
  });
}

/** Full immutable-record verification, run on initial/change load and writes. */
function assertBuildPlanningIntegrity(
  buildPlanning: BuildPlanningAggregateV1,
): void {
  if (
    buildPlanning.planVersions.some(
      (plan) =>
        computeBuildPlanSemanticDigest(plan) !== plan.semanticDigest ||
        computeBuildPlanRecordDigest(plan) !== plan.recordDigest,
    ) ||
    Object.values(buildPlanning.briefVersionsById)
      .flat()
      .some(
        (brief) =>
          computeAgentBriefSemanticDigest(brief) !== brief.semanticDigest ||
          computeAgentBriefRecordDigest(brief) !== brief.recordDigest,
      ) ||
    Object.values(buildPlanning.assignmentByAgentId).some(
      (assignment) =>
        computePlanningAssignmentRecordDigest(assignment) !==
        assignment.recordDigest,
    ) ||
    Object.values(buildPlanning.submissionsByAssignmentId)
      .flat()
      .some(
        (submission) =>
          computePlanningSubmissionSemanticDigest(submission) !==
            submission.semanticDigest ||
          computePlanningSubmissionRecordDigest(submission) !==
            submission.recordDigest,
      )
  )
    throw new AgentMapWorkspaceStoreError("malformed_state");
}

function migrateAggregateV1(
  value: unknown,
  projectId: StudioProjectId,
): AgentMapProjectAggregate {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "storageSchemaVersion",
      "workspace",
      "proposal",
      "receipts",
    ]) ||
    value.storageSchemaVersion !== 1
  )
    throw new AgentMapWorkspaceStoreError("malformed_state");
  const architecture = parseArchitectureFields(value, projectId);
  if (architecture.workspace.projectBuildPlanId !== null)
    throw new AgentMapWorkspaceStoreError("malformed_state");
  return {
    storageSchemaVersion: AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION,
    ...architecture,
    buildPlanning: emptyBuildPlanningAggregate(),
  };
}

/** Crash-atomic owner of workspace, active proposal, history, and private receipts. */
export class AgentMapWorkspaceStore {
  private readonly queues = new Map<StudioProjectId, Promise<void>>();
  private readonly verifiedFileIdentity = new Map<StudioProjectId, string>();

  constructor(
    private readonly agentMapRoot: string,
    private readonly options: {
      now?: () => Date;
      onEvent?: (event: AgentMapWorkspaceStoreEvent) => void | Promise<void>;
      /** Deterministic crash-boundary seam for storage fault tests. */
      beforePersistStep?: (
        step: "write" | "file-sync" | "rename" | "directory-sync",
      ) => void | Promise<void>;
    } = {},
  ) {}

  private workspacePath(projectId: StudioProjectId) {
    return path.join(
      this.agentMapRoot,
      "projects",
      projectId,
      "workspace.json",
    );
  }

  private emit(event: AgentMapWorkspaceStoreEvent): void {
    try {
      void Promise.resolve(this.options.onEvent?.(event)).catch(() => {});
    } catch {
      // Observability cannot change durable state semantics.
    }
  }

  private initial(projectId: StudioProjectId): AgentMapProjectAggregate {
    const timestamp = (this.options.now?.() ?? new Date()).toISOString();
    return {
      storageSchemaVersion: AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION,
      workspace: {
        projectId,
        schemaVersion: AGENT_MAP_WORKSPACE_SCHEMA_VERSION,
        recordVersion: AGENT_MAP_INITIAL_RECORD_VERSION,
        confirmedRevisionId: null,
        activeProposalId: null,
        projectBuildPlanId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      proposal: null,
      receipts: [],
      buildPlanning: emptyBuildPlanningAggregate(),
    };
  }

  private async readDisk(projectId: StudioProjectId): Promise<{
    aggregate: AgentMapProjectAggregate;
    needsWrite: boolean;
    created: boolean;
  }> {
    const file = this.workspacePath(projectId);
    let decoded: unknown;
    let fileIdentity: string;
    try {
      const raw = await fs.readFile(file, "utf8");
      const stat = await fs.stat(file, { bigint: true });
      fileIdentity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
      decoded = JSON.parse(raw) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          aggregate: this.initial(projectId),
          needsWrite: true,
          created: true,
        };
      if (error instanceof SyntaxError)
        throw new AgentMapWorkspaceStoreError("malformed_state");
      throw storageError();
    }
    // Exact E1 record: migrate under the same lock and atomic rename.
    try {
      const workspace = parseAgentMapWorkspaceState(decoded, projectId);
      return {
        aggregate: {
          storageSchemaVersion: AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION,
          workspace,
          proposal: null,
          receipts: [],
          buildPlanning: emptyBuildPlanningAggregate(),
        },
        needsWrite: true,
        created: false,
      };
    } catch (error) {
      if (isRecord(decoded) && "storageSchemaVersion" in decoded) {
        if (decoded.storageSchemaVersion === 1)
          return {
            aggregate: migrateAggregateV1(decoded, projectId),
            needsWrite: true,
            created: false,
          };
        const aggregate = parseAggregate(decoded, projectId);
        if (this.verifiedFileIdentity.get(projectId) !== fileIdentity) {
          assertBuildPlanningIntegrity(aggregate.buildPlanning);
          this.verifiedFileIdentity.set(projectId, fileIdentity);
        }
        return {
          aggregate,
          needsWrite: false,
          created: false,
        };
      }
      throw error;
    }
  }

  private async persist(
    projectId: StudioProjectId,
    aggregate: AgentMapProjectAggregate,
  ): Promise<void> {
    const file = this.workspacePath(projectId);
    const directory = path.dirname(file);
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    let handle: fs.FileHandle | undefined;
    try {
      await fs.mkdir(directory, { recursive: true });
      handle = await fs.open(temporary, "wx", 0o600);
      await this.options.beforePersistStep?.("write");
      await handle.writeFile(`${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
      await this.options.beforePersistStep?.("file-sync");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.options.beforePersistStep?.("rename");
      await fs.rename(temporary, file);
      const directoryHandle = await fs.open(directory, "r");
      try {
        await this.options.beforePersistStep?.("directory-sync");
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      const stat = await fs.stat(file, { bigint: true });
      this.verifiedFileIdentity.set(
        projectId,
        `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`,
      );
    } catch {
      throw storageError();
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private enqueue<T>(
    projectId: StudioProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(projectId, tail);
    void tail.finally(() => {
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    });
    return result;
  }

  private async locked<T>(
    projectId: StudioProjectId,
    operation: (
      aggregate: AgentMapProjectAggregate,
    ) => Promise<{ value: T; next?: AgentMapProjectAggregate }>,
  ): Promise<T> {
    if (!isStudioProjectId(projectId))
      throw new AgentMapWorkspaceStoreError("malformed_state");
    return this.enqueue(projectId, async () => {
      const release = await new DurableFileLock(this.workspacePath(projectId), {
        storageError,
      }).acquire();
      try {
        const loaded = await this.readDisk(projectId);
        const outcome = await operation(structuredClone(loaded.aggregate));
        if (loaded.needsWrite || outcome.next) {
          const next = outcome.next
            ? parseAggregate(outcome.next, projectId)
            : loaded.aggregate;
          if (outcome.next) assertBuildPlanningIntegrity(next.buildPlanning);
          await this.persist(projectId, next);
        }
        if (loaded.created)
          this.emit({ name: "agent_map.workspace_initialized", projectId });
        return structuredClone(outcome.value);
      } finally {
        await release();
      }
    });
  }

  async readAggregate(
    projectId: StudioProjectId,
  ): Promise<AgentMapProjectAggregate> {
    try {
      return await this.locked(projectId, async (aggregate) => ({
        value: aggregate,
      }));
    } catch (error) {
      const bounded =
        error instanceof AgentMapWorkspaceStoreError ? error : storageError();
      this.emit({
        name: "agent_map.workspace_read_failed",
        projectId,
        ...(bounded.schemaVersion === undefined
          ? {}
          : { schemaVersion: bounded.schemaVersion }),
        errorCode: bounded.code,
      });
      throw bounded;
    }
  }

  async readSnapshot(
    projectId: StudioProjectId,
  ): Promise<AgentMapStoreSnapshot> {
    const aggregate = await this.readAggregate(projectId);
    return { workspace: aggregate.workspace, proposal: aggregate.proposal };
  }

  readOrCreate(projectId: StudioProjectId): Promise<AgentMapWorkspaceState> {
    return this.readSnapshot(projectId).then(({ workspace }) => workspace);
  }

  transact<T>(
    projectId: StudioProjectId,
    operation: (
      aggregate: AgentMapProjectAggregate,
    ) => Promise<{ value: T; next?: AgentMapProjectAggregate }>,
  ): Promise<T> {
    return this.locked(projectId, operation);
  }
}
