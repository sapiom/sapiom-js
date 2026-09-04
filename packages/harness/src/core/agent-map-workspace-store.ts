import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AGENT_MAP_INITIAL_RECORD_VERSION,
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  AGENT_MAP_WORKSPACE_SCHEMA_VERSION,
  type AgentMapErrorCode,
  type AgentMapWorkspaceState,
  type MapChangeProposal,
  type MapProposalId,
  type StudioProjectId,
} from "../shared/agent-map.js";
import type {
  AgentBriefHistoryPointer,
  AgentBriefVersion,
  AgentBriefVersionRef,
  ProjectMutationReceipt,
} from "../shared/build-plan.js";
import { parseAgentBriefVersion } from "../shared/build-plan-codec.js";
import {
  AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION,
  AgentMapAggregateError,
  computeProjectPlanningAggregateDigest,
  createEmptyProjectPlanningAggregate,
  migrateProjectPlanningAggregate,
  parseLegacyWorkspaceState,
  parseProjectPlanningAggregate,
  type AgentMapProjectAggregate,
} from "./agent-map-aggregate-migration.js";
import { deterministicVersionId } from "./agent-map-version.js";
import { DurableFileLock } from "./durable-file-lock.js";
import { isStudioProjectId } from "./studio-project-catalog.js";

export {
  AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION,
  type AgentMapProjectAggregate,
};

export interface AgentMapStoreSnapshot {
  workspace: AgentMapWorkspaceState;
  proposal: MapChangeProposal | null;
}

export type AgentMapWorkspaceStoreEvent =
  | { name: "agent_map.workspace_initialized"; projectId: StudioProjectId }
  | { name: "agent_map.workspace_migrated"; projectId: StudioProjectId; fromSchemaVersion: 0 | 1 }
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
    super(code === "unsupported_schema" ? "Agent Map state uses an unsupported schema" :
      code === "malformed_state" ? "Agent Map state is malformed" : "Agent Map storage is unavailable");
    this.name = "AgentMapWorkspaceStoreError";
  }
}

const storageError = () => new AgentMapWorkspaceStoreError("storage_unavailable");

/** Compatibility parser for callers that still inspect the deployed E1 shape. */
export function parseAgentMapWorkspaceState(
  value: unknown,
  expectedProjectId: StudioProjectId,
): AgentMapWorkspaceState {
  try {
    return parseLegacyWorkspaceState(value, expectedProjectId) as AgentMapWorkspaceState;
  } catch (error) {
    if (error instanceof AgentMapAggregateError)
      throw new AgentMapWorkspaceStoreError(error.code, error.schemaVersion);
    throw new AgentMapWorkspaceStoreError("malformed_state");
  }
}

export function projectProposalId(aggregate: AgentMapProjectAggregate): MapProposalId {
  for (const version of aggregate.mapVersions) {
    if (version.origin.kind === "migration" && version.origin.legacyProposalId)
      return version.origin.legacyProposalId;
  }
  return deterministicVersionId("proposal", [aggregate.projectId, "role-neutral-map-stream-v1"]) as MapProposalId;
}

export function projectCompatibilitySnapshot(
  aggregate: AgentMapProjectAggregate,
): AgentMapStoreSnapshot {
  const history = structuredClone(aggregate.mapOperationHistory);
  const currentMap = aggregate.mapVersions.at(-1);
  const hasProposal = history.length > 0 || currentMap !== undefined;
  const proposalId = projectProposalId(aggregate);
  const proposal: MapChangeProposal | null = hasProposal ? {
    schemaVersion: AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
    id: proposalId,
    projectId: aggregate.projectId,
    baseRevisionId: null,
    version: history.at(-1)?.acceptedVersion ?? 0,
    nodes: structuredClone(currentMap?.graph.nodes ?? []),
    relationships: structuredClone(currentMap?.graph.relationships ?? []),
    history,
    createdAt: history[0]?.acceptedAt ?? aggregate.createdAt,
    updatedAt: history.at(-1)?.acceptedAt ?? aggregate.updatedAt,
  } : null;
  return {
    workspace: {
      projectId: aggregate.projectId,
      schemaVersion: AGENT_MAP_WORKSPACE_SCHEMA_VERSION,
      recordVersion: aggregate.recordVersion,
      confirmedRevisionId: aggregate.current.map?.versionId ?? null,
      activeProposalId: proposal?.id ?? null,
      projectBuildPlanId: aggregate.current.buildPlan?.planId ?? null,
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt,
    },
    proposal,
  };
}

export interface AppendBriefVersionsRequest {
  actor: { userId: string; sessionId: string };
  requestId: string;
  requestDigest: string;
  expectedMap: NonNullable<AgentMapProjectAggregate["current"]["map"]>;
  expectedPlan: NonNullable<AgentMapProjectAggregate["current"]["buildPlan"]>;
  entries: readonly Readonly<{
    version: AgentBriefVersion;
    status: AgentBriefHistoryPointer["status"];
  }>[];
  createdAt: string;
}

export interface AppendBriefVersionsResult {
  replayed: boolean;
  versions: readonly AgentBriefVersionRef[];
}

/** Crash-atomic owner of the one final project planning aggregate. */
export class AgentMapWorkspaceStore {
  private readonly queues = new Map<StudioProjectId, Promise<void>>();

  constructor(
    private readonly agentMapRoot: string,
    private readonly options: {
      now?: () => Date;
      onEvent?: (event: AgentMapWorkspaceStoreEvent) => void | Promise<void>;
      beforePersistStep?: (step: "write" | "file-sync" | "rename" | "directory-sync") => void | Promise<void>;
    } = {},
  ) {}

  private workspacePath(projectId: StudioProjectId) {
    return path.join(this.agentMapRoot, "projects", projectId, "workspace.json");
  }

  private emit(event: AgentMapWorkspaceStoreEvent): void {
    try { void Promise.resolve(this.options.onEvent?.(event)).catch(() => {}); } catch { /* telemetry cannot alter storage */ }
  }

  private initial(projectId: StudioProjectId): AgentMapProjectAggregate {
    return createEmptyProjectPlanningAggregate(
      projectId,
      (this.options.now?.() ?? new Date()).toISOString(),
      AGENT_MAP_INITIAL_RECORD_VERSION,
    );
  }

  private async readDisk(projectId: StudioProjectId): Promise<{
    aggregate: AgentMapProjectAggregate;
    needsWrite: boolean;
    created: boolean;
    migratedFrom?: 0 | 1;
  }> {
    const file = this.workspacePath(projectId);
    let decoded: unknown;
    try { decoded = JSON.parse(await fs.readFile(file, "utf8")) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { aggregate: this.initial(projectId), needsWrite: true, created: true };
      if (error instanceof SyntaxError) throw new AgentMapWorkspaceStoreError("malformed_state");
      throw storageError();
    }
    try {
      const migrated = migrateProjectPlanningAggregate(decoded, projectId);
      const from = typeof decoded === "object" && decoded !== null && "storageSchemaVersion" in decoded ? 1 : 0;
      return { aggregate: migrated.aggregate, needsWrite: migrated.migrated, created: false,
        ...(migrated.migrated ? { migratedFrom: from as 0 | 1 } : {}) };
    } catch (error) {
      if (error instanceof AgentMapAggregateError)
        throw new AgentMapWorkspaceStoreError(error.code, error.schemaVersion);
      throw error;
    }
  }

  private async persist(projectId: StudioProjectId, aggregate: AgentMapProjectAggregate): Promise<void> {
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
      try { await this.options.beforePersistStep?.("directory-sync"); await directoryHandle.sync(); }
      finally { await directoryHandle.close(); }
    } catch { throw storageError(); }
    finally { await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  private enqueue<T>(projectId: StudioProjectId, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(projectId, tail);
    void tail.finally(() => { if (this.queues.get(projectId) === tail) this.queues.delete(projectId); });
    return result;
  }

  private async locked<T>(projectId: StudioProjectId, operation: (
    aggregate: AgentMapProjectAggregate,
  ) => Promise<{ value: T; next?: AgentMapProjectAggregate }>): Promise<T> {
    if (!isStudioProjectId(projectId)) throw new AgentMapWorkspaceStoreError("malformed_state");
    return this.enqueue(projectId, async () => {
      const release = await new DurableFileLock(this.workspacePath(projectId), { storageError }).acquire();
      try {
        const loaded = await this.readDisk(projectId);
        const outcome = await operation(structuredClone(loaded.aggregate));
        if (loaded.needsWrite || outcome.next) {
          const candidate = outcome.next ?? loaded.aggregate;
          const next = parseProjectPlanningAggregate({ ...candidate,
            aggregateDigest: computeProjectPlanningAggregateDigest(candidate) }, projectId);
          await this.persist(projectId, next);
        }
        if (loaded.created) this.emit({ name: "agent_map.workspace_initialized", projectId });
        if (loaded.migratedFrom !== undefined)
          this.emit({ name: "agent_map.workspace_migrated", projectId, fromSchemaVersion: loaded.migratedFrom });
        return structuredClone(outcome.value);
      } finally { await release(); }
    });
  }

  async readAggregate(projectId: StudioProjectId): Promise<AgentMapProjectAggregate> {
    try { return await this.locked(projectId, async (aggregate) => ({ value: aggregate })); }
    catch (error) {
      const bounded = error instanceof AgentMapWorkspaceStoreError ? error : storageError();
      this.emit({ name: "agent_map.workspace_read_failed", projectId,
        ...(bounded.schemaVersion === undefined ? {} : { schemaVersion: bounded.schemaVersion }), errorCode: bounded.code });
      throw bounded;
    }
  }

  async readSnapshot(projectId: StudioProjectId): Promise<AgentMapStoreSnapshot> {
    return projectCompatibilitySnapshot(await this.readAggregate(projectId));
  }

  readOrCreate(projectId: StudioProjectId): Promise<AgentMapWorkspaceState> {
    return this.readSnapshot(projectId).then(({ workspace }) => workspace);
  }

  transact<T>(projectId: StudioProjectId, operation: (
    aggregate: AgentMapProjectAggregate,
  ) => Promise<{ value: T; next?: AgentMapProjectAggregate }>): Promise<T> {
    return this.locked(projectId, operation);
  }

  /** Reserved exact-source, idempotent append seam. SAP-3149 has no caller. */
  appendBriefVersions(projectId: StudioProjectId, request: AppendBriefVersionsRequest): Promise<AppendBriefVersionsResult> {
    return this.transact<AppendBriefVersionsResult>(projectId, async (aggregate) => {
      const keyMatches = (entry: { userId: string; sessionId: string; requestId: string }) =>
        entry.userId === request.actor.userId && entry.sessionId === request.actor.sessionId && entry.requestId === request.requestId;
      const receipt = aggregate.requestReceipts.find(keyMatches);
      if (receipt) {
        if (receipt.operation !== "brief_append" || receipt.requestDigest !== request.requestDigest)
          throw new AgentMapWorkspaceStoreError("malformed_state");
        return { value: { ...(structuredClone(receipt.result) as AppendBriefVersionsResult), replayed: true } };
      }
      if (aggregate.requestTombstones.some(keyMatches)) throw new AgentMapWorkspaceStoreError("malformed_state");
      if (JSON.stringify(aggregate.current.map) !== JSON.stringify(request.expectedMap) ||
        JSON.stringify(aggregate.current.buildPlan) !== JSON.stringify(request.expectedPlan))
        throw new AgentMapWorkspaceStoreError("malformed_state");
      const next = structuredClone(aggregate);
      const versions: AgentBriefVersionRef[] = [];
      for (const entry of request.entries) {
        const parsed = parseAgentBriefVersion(entry.version, projectId);
        if (JSON.stringify(parsed.map) !== JSON.stringify(request.expectedMap) ||
          JSON.stringify(parsed.plan) !== JSON.stringify(request.expectedPlan))
          throw new AgentMapWorkspaceStoreError("malformed_state");
        const history = next.briefVersionsById[parsed.briefId] ?? [];
        const pointer = next.current.briefsByScope[parsed.scopeKey];
        if (parsed.version !== history.length + 1 || parsed.parentVersionId !== (history.at(-1)?.versionId ?? null) ||
          (pointer !== undefined && pointer.briefId !== parsed.briefId)) throw new AgentMapWorkspaceStoreError("malformed_state");
        next.briefVersionsById[parsed.briefId] = [...history, parsed];
        const ref = { projectId, briefId: parsed.briefId, versionId: parsed.versionId, semanticDigest: parsed.semanticDigest };
        next.current.briefsByScope[parsed.scopeKey] = { scopeKey: parsed.scopeKey, focusScope: parsed.focusScope,
          briefId: parsed.briefId, status: entry.status, version: ref };
        versions.push(ref);
      }
      const result: AppendBriefVersionsResult = { replayed: false, versions };
      const receiptRecord: ProjectMutationReceipt<AppendBriefVersionsResult> = { projectId, ...request.actor,
        requestId: request.requestId, requestDigest: request.requestDigest, operation: "brief_append", result,
        createdAt: request.createdAt };
      next.requestReceipts.push(receiptRecord);
      next.recordVersion += 1;
      next.updatedAt = request.createdAt;
      return { value: result, next };
    });
  }
}
