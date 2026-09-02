import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AGENT_MAP_INITIAL_RECORD_VERSION,
  AGENT_MAP_WORKSPACE_SCHEMA_VERSION,
  type AgentMapErrorCode,
  type AgentMapWorkspaceState,
  type MapChangeProposal,
  type ProposalBatchResult,
  type StudioProjectId,
} from "../shared/agent-map.js";
import {
  parseMapChangeProposal,
  proposalReceiptSchema,
} from "../shared/agent-map-codec.js";
import type { ProposalTouchSet } from "./agent-map-proposal-validator.js";
import { DurableFileLock } from "./durable-file-lock.js";
import { isStudioProjectId } from "./studio-project-catalog.js";

export const AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION = 1;

export interface AgentMapProposalReceipt {
  sessionId: string;
  requestId: string;
  requestDigest: string;
  result: ProposalBatchResult;
  touchSet: ProposalTouchSet;
}

export interface AgentMapProjectAggregate {
  storageSchemaVersion: typeof AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION;
  workspace: AgentMapWorkspaceState;
  proposal: MapChangeProposal | null;
  receipts: AgentMapProposalReceipt[];
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
    ]) ||
    value.storageSchemaVersion !== AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION ||
    !Array.isArray(value.receipts)
  )
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
    const parsed = proposalReceiptSchema.safeParse(receipt);
    if (
      !parsed.success ||
      proposal === null ||
      parsed.data.result.proposalId !== proposal.id ||
      parsed.data.result.delta.projectId !== projectId ||
      parsed.data.result.version > proposal.version
    )
      throw new AgentMapWorkspaceStoreError("malformed_state");
    receipts.push(parsed.data as AgentMapProposalReceipt);
  }
  if (
    new Set(
      receipts.map(({ sessionId, requestId }) => `${sessionId}\0${requestId}`),
    ).size !== receipts.length
  )
    throw new AgentMapWorkspaceStoreError("malformed_state");
  return structuredClone({
    storageSchemaVersion: AGENT_MAP_AGGREGATE_STORAGE_SCHEMA_VERSION,
    workspace,
    proposal,
    receipts,
  }) as AgentMapProjectAggregate;
}

/** Crash-atomic owner of workspace, active proposal, history, and private receipts. */
export class AgentMapWorkspaceStore {
  private readonly queues = new Map<StudioProjectId, Promise<void>>();

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
    };
  }

  private async readDisk(projectId: StudioProjectId): Promise<{
    aggregate: AgentMapProjectAggregate;
    needsWrite: boolean;
    created: boolean;
  }> {
    const file = this.workspacePath(projectId);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
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
          storageSchemaVersion: 1,
          workspace,
          proposal: null,
          receipts: [],
        },
        needsWrite: true,
        created: false,
      };
    } catch (error) {
      if (isRecord(decoded) && "storageSchemaVersion" in decoded) {
        return {
          aggregate: parseAggregate(decoded, projectId),
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
        if (loaded.needsWrite || outcome.next)
          await this.persist(projectId, outcome.next ?? loaded.aggregate);
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
