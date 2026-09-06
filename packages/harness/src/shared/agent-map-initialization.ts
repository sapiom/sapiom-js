/** Public, bounded initialization state. Never contains evidence or model output. */
export type AgentMapInitializationState =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "failed";
export const AGENT_MAP_INITIALIZATION_ERRORS = [
  "interrupted",
  "cancelled",
  "timeout",
  "provider_unavailable",
  "provider_failed",
  "invalid_output",
  "evidence_unavailable",
  "limit_exceeded",
  "storage_unavailable",
] as const;
export type AgentMapInitializationError =
  (typeof AGENT_MAP_INITIALIZATION_ERRORS)[number];
export interface AgentMapInitializationStatus {
  projectId: string;
  status: AgentMapInitializationState;
  errorCode: AgentMapInitializationError | null;
  retryable: boolean;
}

export function parseAgentMapInitializationStatus(
  value: unknown,
  projectId?: string,
): AgentMapInitializationStatus {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Agent Map initialization status");
  const v = value as Record<string, unknown>;
  if (
    typeof v.projectId !== "string" ||
    v.projectId.length > 128 ||
    (projectId !== undefined && v.projectId !== projectId) ||
    !["idle", "queued", "running", "completed", "skipped", "failed"].includes(
      String(v.status),
    ) ||
    (v.errorCode !== null &&
      !AGENT_MAP_INITIALIZATION_ERRORS.includes(
        v.errorCode as AgentMapInitializationError,
      )) ||
    typeof v.retryable !== "boolean"
  )
    throw new Error("Invalid Agent Map initialization status");
  return {
    projectId: v.projectId,
    status: v.status as AgentMapInitializationState,
    errorCode: v.errorCode as AgentMapInitializationError | null,
    retryable: v.retryable,
  };
}
