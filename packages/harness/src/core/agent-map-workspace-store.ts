import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AGENT_MAP_INITIAL_RECORD_VERSION,
  AGENT_MAP_WORKSPACE_SCHEMA_VERSION,
  type AgentMapErrorCode,
  type AgentMapWorkspaceState,
  type StudioProjectId,
} from "../shared/agent-map.js";
import { isStudioProjectId } from "./studio-project-catalog.js";

export type AgentMapWorkspaceStoreEvent =
  | {
      name: "agent_map.workspace_initialized";
      projectId: StudioProjectId;
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    !hasControlCharacter(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes(":")
  );
}

function isNullableOpaqueId(value: unknown): value is string | null {
  return value === null || isOpaqueId(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function parseAgentMapWorkspaceState(
  value: unknown,
  expectedProjectId: StudioProjectId,
): AgentMapWorkspaceState {
  const readableSchemaVersion =
    isRecord(value) &&
    Number.isSafeInteger(value.schemaVersion) &&
    (value.schemaVersion as number) >= 0
      ? (value.schemaVersion as number)
      : undefined;
  if (
    readableSchemaVersion !== undefined &&
    readableSchemaVersion > AGENT_MAP_WORKSPACE_SCHEMA_VERSION
  ) {
    throw new AgentMapWorkspaceStoreError(
      "unsupported_schema",
      readableSchemaVersion,
    );
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
    !Number.isSafeInteger(value.schemaVersion) ||
    !Number.isSafeInteger(value.recordVersion) ||
    (value.recordVersion as number) < 1 ||
    !isNullableOpaqueId(value.confirmedRevisionId) ||
    !isNullableOpaqueId(value.activeProposalId) ||
    !isNullableOpaqueId(value.projectBuildPlanId) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw new AgentMapWorkspaceStoreError(
      "malformed_state",
      readableSchemaVersion,
    );
  }
  if (value.schemaVersion !== AGENT_MAP_WORKSPACE_SCHEMA_VERSION) {
    throw new AgentMapWorkspaceStoreError(
      (value.schemaVersion as number) > AGENT_MAP_WORKSPACE_SCHEMA_VERSION
        ? "unsupported_schema"
        : "malformed_state",
      value.schemaVersion as number,
    );
  }
  return {
    projectId: value.projectId,
    schemaVersion: value.schemaVersion as number,
    recordVersion: value.recordVersion as number,
    confirmedRevisionId: value.confirmedRevisionId,
    activeProposalId: value.activeProposalId,
    projectBuildPlanId: value.projectBuildPlanId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function storageError(): AgentMapWorkspaceStoreError {
  return new AgentMapWorkspaceStoreError("storage_unavailable");
}

/** Lazy, restart-safe owner of each project's empty Agent Map workspace. */
export class AgentMapWorkspaceStore {
  private readonly reads = new Map<
    StudioProjectId,
    Promise<AgentMapWorkspaceState>
  >();

  constructor(
    private readonly agentMapRoot: string,
    private readonly options: {
      now?: () => Date;
      onEvent?: (event: AgentMapWorkspaceStoreEvent) => void | Promise<void>;
    } = {},
  ) {}

  private workspacePath(projectId: StudioProjectId): string {
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
      // Observability is best-effort and cannot change durable state semantics.
    }
  }

  private async read(
    projectId: StudioProjectId,
  ): Promise<AgentMapWorkspaceState> {
    const workspacePath = this.workspacePath(projectId);
    let raw: string;
    try {
      raw = await fs.readFile(workspacePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.create(projectId, workspacePath);
      }
      throw storageError();
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      throw new AgentMapWorkspaceStoreError("malformed_state");
    }
    return parseAgentMapWorkspaceState(decoded, projectId);
  }

  private async create(
    projectId: StudioProjectId,
    workspacePath: string,
  ): Promise<AgentMapWorkspaceState> {
    const timestamp = (this.options.now?.() ?? new Date()).toISOString();
    const workspace: AgentMapWorkspaceState = {
      projectId,
      schemaVersion: AGENT_MAP_WORKSPACE_SCHEMA_VERSION,
      recordVersion: AGENT_MAP_INITIAL_RECORD_VERSION,
      confirmedRevisionId: null,
      activeProposalId: null,
      projectBuildPlanId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const directory = path.dirname(workspacePath);
    const temporary = `${workspacePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        temporary,
        `${JSON.stringify(workspace, null, 2)}\n`,
        "utf8",
      );
      // `rename()` replaces an existing target on POSIX, so it cannot select
      // one winner across two Studio processes (or even two store instances).
      // The temporary file is already complete; linking it into the final name
      // is an atomic, no-clobber commit. An EEXIST loser reads and returns the
      // winner instead of publishing its divergent timestamp or event.
      await fs.link(temporary, workspacePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return this.readExisting(projectId, workspacePath);
      }
      throw storageError();
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    this.emit({ name: "agent_map.workspace_initialized", projectId });
    return workspace;
  }

  private async readExisting(
    projectId: StudioProjectId,
    workspacePath: string,
  ): Promise<AgentMapWorkspaceState> {
    let raw: string;
    try {
      raw = await fs.readFile(workspacePath, "utf8");
    } catch {
      throw storageError();
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      throw new AgentMapWorkspaceStoreError("malformed_state");
    }
    return parseAgentMapWorkspaceState(decoded, projectId);
  }

  /**
   * The only E1 initializer. Concurrent calls share one per-project promise;
   * no inventory, scanner, graph builder, or model dependency is reachable.
   */
  readOrCreate(projectId: StudioProjectId): Promise<AgentMapWorkspaceState> {
    if (!isStudioProjectId(projectId)) {
      return Promise.reject(new AgentMapWorkspaceStoreError("malformed_state"));
    }
    const active = this.reads.get(projectId);
    if (active) return active;
    const operation = this.read(projectId)
      .catch((error: unknown) => {
        const bounded =
          error instanceof AgentMapWorkspaceStoreError ? error : storageError();
        this.emit({
          name: "agent_map.workspace_read_failed",
          projectId,
          ...(bounded.schemaVersion !== undefined
            ? { schemaVersion: bounded.schemaVersion }
            : {}),
          errorCode: bounded.code,
        });
        throw bounded;
      })
      .finally(() => {
        if (this.reads.get(projectId) === operation) {
          this.reads.delete(projectId);
        }
      });
    this.reads.set(projectId, operation);
    return operation;
  }
}
