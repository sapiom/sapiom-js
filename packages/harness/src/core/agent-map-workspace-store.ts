import { initializationRecordSchema, type AgentMapInitializationTransaction } from "./agent-map-initialization-record.js";
import { createHash, randomUUID } from "node:crypto";
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
import { parseProjectAgentActorRef } from "../shared/agent-map-codec.js";
import { canonicalJson } from "../shared/agent-map-canonical.js";
import type {
  AgentBriefHistoryPointer,
  AgentBriefVersion,
  AgentBriefVersionRef,
  ProjectMutationReceipt,
} from "../shared/build-plan.js";
import type { AgentBriefRefreshReceipt } from "../shared/agent-brief.js";
import {
  AGENT_BRIEF_VERSION_HISTORY_LIMIT,
  PROJECT_MUTATION_RECEIPT_LIMIT,
  PROJECT_MUTATION_TOMBSTONE_LIMIT,
} from "../shared/build-plan.js";
import { parseAgentBriefVersion, parseAgentMapVersionRef, parseProjectBuildPlanVersionRef } from "../shared/build-plan-codec.js";
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
import { convertEmptyLegacyContainer } from "./agent-map-empty-legacy-container.js";

export {
  AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION,
  type AgentMapProjectAggregate,
};

export interface AgentMapStoreSnapshot {
  workspace: AgentMapWorkspaceState;
  proposal: MapChangeProposal | null;
}

export type AgentMapWorkspaceStoreEvent =
  | { name: "agent_map.legacy_reset"; projectId: StudioProjectId }
  | { name: "agent_map.empty_legacy_container_migrated"; projectId: StudioProjectId }
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

export const AGENT_BRIEF_RECEIPT_RETENTION_LIMIT = 256;

export class AgentBriefAppendQuotaError extends Error {
  readonly code = "quota_exceeded" as const;

  constructor(readonly resource: "brief_versions" | "request_receipts" | "request_tombstones") {
    super(`Agent brief ${resource.replace(/_/gu, " ")} quota is exhausted`);
    this.name = "AgentBriefAppendQuotaError";
  }
}

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
  receipt: AgentBriefRefreshReceipt;
  createdAt: string;
}

export interface AppendBriefVersionsResult {
  replayed: boolean;
  versions: readonly AgentBriefVersionRef[];
  receipt: AgentBriefRefreshReceipt;
}

/** Crash-atomic owner of the one final project planning aggregate. */
export class AgentMapWorkspaceStore {
  private readonly queues = new Map<StudioProjectId, Promise<void>>();
  private readonly briefReceiptRetentionLimit: number;
  private readonly briefVersionHistoryLimit: number;

  constructor(
    private readonly agentMapRoot: string,
    private readonly options: {
      now?: () => Date;
      onEvent?: (event: AgentMapWorkspaceStoreEvent) => void | Promise<void>;
      beforePersistStep?: (step: "write" | "file-sync" | "rename" | "directory-sync") => void | Promise<void>;
      beforeInitializationWrite?: (status: string) => void | Promise<void>;
      beforeLegacyResetStep?: (step: "prepared" | "deleted") => void | Promise<void>;
      briefReceiptRetentionLimit?: number;
      briefVersionHistoryLimit?: number;
    } = {},
  ) {
    this.briefReceiptRetentionLimit = options.briefReceiptRetentionLimit ?? AGENT_BRIEF_RECEIPT_RETENTION_LIMIT;
    this.briefVersionHistoryLimit = options.briefVersionHistoryLimit ?? AGENT_BRIEF_VERSION_HISTORY_LIMIT;
    if (!Number.isSafeInteger(this.briefReceiptRetentionLimit) || this.briefReceiptRetentionLimit < 1 ||
      this.briefReceiptRetentionLimit > PROJECT_MUTATION_RECEIPT_LIMIT)
      throw new RangeError("briefReceiptRetentionLimit must be a positive safe integer within the receipt quota");
    if (!Number.isSafeInteger(this.briefVersionHistoryLimit) || this.briefVersionHistoryLimit < 1 ||
      this.briefVersionHistoryLimit > AGENT_BRIEF_VERSION_HISTORY_LIMIT)
      throw new RangeError("briefVersionHistoryLimit must be a positive safe integer within the history quota");
  }

  private workspacePath(projectId: StudioProjectId) {
    return path.join(this.agentMapRoot, "projects", projectId, "workspace.json");
  }

  private async writeSidecar(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw storageError(); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  /** Call only under the workspace lock. Outer version is the sole reset discriminator. */
  private async resetLegacyLocked(projectId: StudioProjectId): Promise<boolean> {
    const file = this.workspacePath(projectId);
    const marker = path.join(path.dirname(file), "legacy-reset.json");
    let decoded: unknown;
    try { decoded = JSON.parse(await fs.readFile(file, "utf8")) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw storageError();
      // Invalid JSON is preserved for the map reader to classify; it is never absence.
    }
    if (typeof decoded === "object" && decoded !== null &&
      "storageSchemaVersion" in decoded && decoded.storageSchemaVersion === 1) {
      await this.writeSidecar(marker, { schemaVersion: 1, projectId, status: "prepared" });
      await this.options.beforeLegacyResetStep?.("prepared");
      await fs.unlink(file);
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      await this.options.beforeLegacyResetStep?.("deleted");
      await this.writeSidecar(marker, { schemaVersion: 1, projectId, status: "completed" });
      this.emit({ name: "agent_map.legacy_reset", projectId });
      return true;
    }
    // Finish a journal interrupted after deletion. A subsequently authored format 2 is untouched.
    try {
      const record = JSON.parse(await fs.readFile(marker, "utf8")) as { status?: string; projectId?: string };
      if (record.status === "prepared" && record.projectId === projectId)
        await this.writeSidecar(marker, { schemaVersion: 1, projectId, status: "completed" });
    } catch {
      // This marker records reset progress; it is not map authority. A damaged
      // or unreadable marker must not hide an intact format-2 workspace. The
      // primary read below still distinguishes absence from malformed state
      // and I/O failures, and a qualifying format 1 always prepares a new marker
      // successfully before deletion.
    }
    return false;
  }

  /** Shared desktop/CLI startup; does not parse, convert, or persist format-2 workspaces. */
  async resetLegacyMaps(): Promise<void> {
    let entries: string[];
    try { entries = await fs.readdir(path.join(this.agentMapRoot, "projects")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw storageError(); }
    for (const projectId of entries.filter(isStudioProjectId)) {
      try {
        await this.enqueue(projectId, async () => {
          const release = await new DurableFileLock(this.workspacePath(projectId), { storageError }).acquire();
          try { await this.resetLegacyLocked(projectId); } finally { await release(); }
        });
      } catch {
        this.emit({ name: "agent_map.workspace_read_failed", projectId, errorCode: "storage_unavailable" });
      }
    }
  }

  /** Separate, narrowly scoped compatibility pass before bootstrap/discovery.
   * Existing current-format-2 and non-pristine records are never rewritten. */
  async migrateEmptyLegacyContainers(): Promise<void> {
    let entries: string[];
    try { entries = await fs.readdir(path.join(this.agentMapRoot, "projects")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw storageError(); }
    for (const projectId of entries.filter(isStudioProjectId)) {
      try {
        await this.enqueue(projectId, async () => {
          const release = await new DurableFileLock(this.workspacePath(projectId), { storageError }).acquire();
          try {
            const raw = await fs.readFile(this.workspacePath(projectId));
            let decoded: unknown;
            try { decoded = JSON.parse(raw.toString("utf8")) as unknown; }
            catch { return; } // A malformed primary file remains a storage error, never absence.
            await this.migrateEmptyLegacyContainerLocked(projectId, raw, decoded);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          } finally { await release(); }
        });
      } catch {
        this.emit({ name: "agent_map.workspace_read_failed", projectId, errorCode: "storage_unavailable" });
      }
    }
  }

  /** Under the project lock, preserve exact source bytes durably before conversion.
   * Linking a synced temporary file publishes the backup without replacing an
   * existing one. A crash leaves either the old container or the complete new
   * aggregate; repeated access verifies/reuses the same content-addressed backup. */
  private async migrateEmptyLegacyContainerLocked(
    projectId: StudioProjectId,
    raw: Buffer,
    decoded: unknown,
  ): Promise<AgentMapProjectAggregate | null> {
    const converted = convertEmptyLegacyContainer(decoded, projectId);
    if (!converted) return null;
    const aggregate = parseProjectPlanningAggregate(converted, projectId);
    const file = this.workspacePath(projectId);
    const digest = createHash("sha256").update(raw).digest("hex");
    const backup = path.join(path.dirname(file), `workspace.empty-wrapped-v2.${digest}.backup.json`);
    const temporary = `${backup}.tmp-${randomUUID()}`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(raw); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.link(temporary, backup); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!(await fs.readFile(backup)).equals(raw)) throw storageError();
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw storageError(); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    await this.persist(projectId, aggregate);
    this.emit({ name: "agent_map.empty_legacy_container_migrated", projectId });
    return aggregate;
  }

  private initializationTransaction(projectId: StudioProjectId): AgentMapInitializationTransaction {
    const file = path.join(path.dirname(this.workspacePath(projectId)), "initialization.json");
    return {
      read: async () => {
        try {
          const record = initializationRecordSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
          if (record.projectId !== projectId) throw storageError();
          return record;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw storageError(); }
      },
      write: async (record) => {
        const parsed = initializationRecordSchema.parse(record);
        if (parsed.projectId !== projectId) throw storageError();
        await this.options.beforeInitializationWrite?.(parsed.status);
        await this.writeSidecar(file, parsed);
      },
    };
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

  private async readDisk(projectId: StudioProjectId, allowMigration = true): Promise<{
    aggregate: AgentMapProjectAggregate;
    needsWrite: boolean;
    created: boolean;
    migratedFrom?: 0 | 1;
  }> {
    await this.resetLegacyLocked(projectId);
    const file = this.workspacePath(projectId);
    let decoded: unknown;
    let raw: Buffer;
    try {
      raw = await fs.readFile(file);
      decoded = JSON.parse(raw.toString("utf8")) as unknown;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { aggregate: this.initial(projectId), needsWrite: true, created: true };
      if (error instanceof SyntaxError) throw new AgentMapWorkspaceStoreError("malformed_state");
      throw storageError();
    }
    try {
      // Eligibility reads need this too: conversion must complete before the
      // coordinator can classify an old empty wrapper as safe to initialize.
      decoded = await this.migrateEmptyLegacyContainerLocked(projectId, raw, decoded) ?? decoded;
      if (!allowMigration && (typeof decoded !== "object" || decoded === null || !("storageSchemaVersion" in decoded) || decoded.storageSchemaVersion !== 2))
        throw new AgentMapWorkspaceStoreError("unsupported_schema");
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
    initialization: AgentMapInitializationTransaction,
  ) => Promise<{ value: T; next?: AgentMapProjectAggregate }>, persistEmpty = true): Promise<T> {
    if (!isStudioProjectId(projectId)) throw new AgentMapWorkspaceStoreError("malformed_state");
    return this.enqueue(projectId, async () => {
      const release = await new DurableFileLock(this.workspacePath(projectId), { storageError }).acquire();
      try {
        const loaded = await this.readDisk(projectId, persistEmpty);
        const outcome = await operation(structuredClone(loaded.aggregate), this.initializationTransaction(projectId));
        if ((persistEmpty && loaded.needsWrite) || outcome.next) {
          const candidate = outcome.next ?? loaded.aggregate;
          const next = parseProjectPlanningAggregate({ ...candidate,
            aggregateDigest: computeProjectPlanningAggregateDigest(candidate) }, projectId);
          await this.persist(projectId, next);
        }
        if (loaded.created && persistEmpty) this.emit({ name: "agent_map.workspace_initialized", projectId });
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
    initialization: AgentMapInitializationTransaction,
  ) => Promise<{ value: T; next?: AgentMapProjectAggregate }>): Promise<T> {
    return this.locked(projectId, operation);
  }

  /** Eligibility/journal access uses the map lock but never creates an empty map file. */
  inspectInitialization<T>(projectId: StudioProjectId, operation: (
    aggregate: AgentMapProjectAggregate,
    initialization: AgentMapInitializationTransaction,
  ) => Promise<T>): Promise<T> {
    return this.locked(projectId, async (aggregate, journal) => ({ value: await operation(aggregate, journal) }), false);
  }

  /** Reserved exact-source, idempotent append seam. SAP-3149 has no caller. */
  appendBriefVersions(projectId: StudioProjectId, request: AppendBriefVersionsRequest): Promise<AppendBriefVersionsResult> {
    let actor: AppendBriefVersionsRequest["actor"];
    try {
      actor = parseProjectAgentActorRef(request.actor);
      parseAgentMapVersionRef(request.expectedMap, projectId);
      parseProjectBuildPlanVersionRef(request.expectedPlan, projectId);
      if (!/^sha256:[0-9a-f]{64}$/u.test(request.requestDigest) || request.requestId.length === 0 ||
        request.requestId.length > 128 || request.entries.length === 0 || request.entries.length > 128 ||
        canonicalJson(request.receipt.map) !== canonicalJson(request.expectedMap) ||
        canonicalJson(request.receipt.plan) !== canonicalJson(request.expectedPlan) ||
        new Date(request.createdAt).toISOString() !== request.createdAt) throw new Error("invalid brief append request");
    } catch {
      throw new AgentMapWorkspaceStoreError("malformed_state");
    }
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
      if (canonicalJson(aggregate.current.map) !== canonicalJson(request.expectedMap) ||
        canonicalJson(aggregate.current.buildPlan) !== canonicalJson(request.expectedPlan))
        throw new AgentMapWorkspaceStoreError("malformed_state");
      const next = structuredClone(aggregate);
      const versions: AgentBriefVersionRef[] = [];
      for (const entry of request.entries) {
        let parsed: AgentBriefVersion;
        try { parsed = parseAgentBriefVersion(entry.version, projectId); }
        catch { throw new AgentMapWorkspaceStoreError("malformed_state"); }
        if (JSON.stringify(parsed.map) !== JSON.stringify(request.expectedMap) ||
          JSON.stringify(parsed.plan) !== JSON.stringify(request.expectedPlan))
          throw new AgentMapWorkspaceStoreError("malformed_state");
        const history = next.briefVersionsById[parsed.briefId] ?? [];
        if (history.length >= this.briefVersionHistoryLimit)
          throw new AgentBriefAppendQuotaError("brief_versions");
        const pointer = next.current.briefsByScope[parsed.scopeKey];
        if (parsed.version !== history.length + 1 || parsed.parentVersionId !== (history.at(-1)?.versionId ?? null) ||
          (pointer !== undefined && pointer.briefId !== parsed.briefId)) throw new AgentMapWorkspaceStoreError("malformed_state");
        next.briefVersionsById[parsed.briefId] = [...history, parsed];
        const ref = { projectId, briefId: parsed.briefId, versionId: parsed.versionId, semanticDigest: parsed.semanticDigest };
        next.current.briefsByScope[parsed.scopeKey] = { scopeKey: parsed.scopeKey, focusScope: parsed.focusScope,
          briefId: parsed.briefId, status: entry.status, version: ref };
        versions.push(ref);
      }
      const result: AppendBriefVersionsResult = { replayed: false, versions,
        receipt: structuredClone(request.receipt) };
      const receiptRecord: ProjectMutationReceipt<AppendBriefVersionsResult> = { projectId, ...actor,
        requestId: request.requestId, requestDigest: request.requestDigest, operation: "brief_append", result,
        createdAt: request.createdAt };
      next.requestReceipts.push(receiptRecord);
      const briefReceipts = () => next.requestReceipts.filter(({ operation }) => operation === "brief_append");
      const expiring = Math.max(0, briefReceipts().length - this.briefReceiptRetentionLimit);
      if (next.requestTombstones.length + expiring > PROJECT_MUTATION_TOMBSTONE_LIMIT)
        throw new AgentBriefAppendQuotaError("request_tombstones");
      if (next.requestReceipts.length - expiring > PROJECT_MUTATION_RECEIPT_LIMIT)
        throw new AgentBriefAppendQuotaError("request_receipts");
      for (let count = 0; count < expiring; count += 1) {
        const expiredIndex = next.requestReceipts.findIndex(({ operation }) => operation === "brief_append");
        const [expired] = next.requestReceipts.splice(expiredIndex, 1);
        if (expired) next.requestTombstones.push({ projectId: expired.projectId, userId: expired.userId,
          sessionId: expired.sessionId, requestId: expired.requestId, operation: expired.operation,
          createdAt: expired.createdAt });
      }
      next.recordVersion += 1;
      next.updatedAt = request.createdAt;
      return { value: result, next };
    });
  }
}
