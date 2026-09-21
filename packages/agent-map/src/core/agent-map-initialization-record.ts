import { z } from "zod";
import {
  AGENT_MAP_INITIALIZATION_ERRORS,
  type AgentMapInitializationError,
  type AgentMapInitializationStatus,
} from "../shared/agent-map-initialization.js";
import type { AgentMapProjectAggregate } from "./agent-map-aggregate-migration.js";

/** Separate journal: adding initialization does not change the format-2 schema. */
export const initializationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1).max(128),
    userId: z.string().min(1).max(256),
    attemptId: z.string().uuid(),
    status: z.enum(["queued", "running", "completed", "skipped", "failed"]),
    ownerId: z.string().uuid().nullable(),
    ownerPid: z.number().int().positive().nullable(),
    provider: z.enum(["claude-code", "codex"]).nullable(),
    errorCode: z.enum(AGENT_MAP_INITIALIZATION_ERRORS).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AgentMapInitializationRecord = z.infer<
  typeof initializationRecordSchema
>;

export function hasAuthoredAgentMap(
  aggregate: AgentMapProjectAggregate,
): boolean {
  return (
    aggregate.current.map !== null ||
    aggregate.mapVersions.length > 0 ||
    aggregate.mapOperationHistory.length > 0
  );
}

export function initializationStatus(
  projectId: string,
  record: AgentMapInitializationRecord | null,
): AgentMapInitializationStatus {
  return {
    projectId,
    status: record?.status ?? "idle",
    errorCode: record?.errorCode ?? null,
    retryable: record?.status === "failed",
  };
}

/** Used only while the owning workspace lock is held. */
export interface AgentMapInitializationTransaction {
  read(): Promise<AgentMapInitializationRecord | null>;
  write(record: AgentMapInitializationRecord): Promise<void>;
}

export class AgentMapInitializationFailure extends Error {
  constructor(readonly code: AgentMapInitializationError) {
    super(code);
  }
}
