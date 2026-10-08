import {
  parseOpenCodeTransportFailure,
  type OpenCodeTransportFailure,
} from "./opencode-errors.js";

export interface AssistantSessionSummary {
  harnessSessionId: string;
  conversationId: string;
  activity: "unknown" | "idle" | "busy" | "retry";
  pendingPermissions: number | null;
  pendingQuestions: number | null;
  freshness: "connecting" | "current" | "reconnecting" | "unavailable";
  failure?: OpenCodeTransportFailure;
}
export interface AssistantStateSnapshot {
  hostInstanceId: string;
  authorityRevision: string;
  revision: number;
  enabled: boolean;
  sessions: readonly AssistantSessionSummary[];
}
export type AssistantObservation = Omit<
  AssistantSessionSummary,
  "harnessSessionId" | "conversationId"
>;

export const isConversationId = (id: unknown): id is string =>
  typeof id === "string" && /^ses_[A-Za-z0-9_-]{1,128}$/.test(id);

const object = (
  value: unknown,
  keys: string[],
): Record<string, unknown> | null =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key))
    ? (value as Record<string, unknown>)
    : null;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const count = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

/** Decode the full public projection; no native diagnostics or extra fields cross it. */
export function parseAssistantState(
  value: unknown,
): AssistantStateSnapshot | null {
  const input = object(value, [
    "hostInstanceId",
    "authorityRevision",
    "revision",
    "enabled",
    "sessions",
  ]);
  if (
    !input ||
    !id(input.hostInstanceId) ||
    !id(input.authorityRevision) ||
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    typeof input.enabled !== "boolean" ||
    !Array.isArray(input.sessions) ||
    (!input.enabled && input.sessions.length)
  )
    return null;
  const sessions: AssistantSessionSummary[] = [];
  const seen = new Set<string>();
  for (const raw of input.sessions) {
    const row = object(raw, [
      "harnessSessionId",
      "conversationId",
      "activity",
      "pendingPermissions",
      "pendingQuestions",
      "freshness",
      "failure",
    ]);
    if (
      !row ||
      !id(row.harnessSessionId) ||
      !isConversationId(row.conversationId) ||
      row.conversationId === row.harnessSessionId ||
      seen.has(row.harnessSessionId) ||
      typeof row.activity !== "string" ||
      !["unknown", "idle", "busy", "retry"].includes(row.activity) ||
      typeof row.freshness !== "string" ||
      !["connecting", "current", "reconnecting", "unavailable"].includes(
        row.freshness,
      ) ||
      !count(row.pendingPermissions) ||
      !count(row.pendingQuestions)
    )
      return null;
    const failure =
      row.failure === undefined
        ? undefined
        : parseOpenCodeTransportFailure(row.failure);
    if (failure === null) return null;
    seen.add(row.harnessSessionId);
    sessions.push({
      harnessSessionId: row.harnessSessionId,
      conversationId: row.conversationId,
      activity: row.activity as AssistantSessionSummary["activity"],
      pendingPermissions: row.pendingPermissions,
      pendingQuestions: row.pendingQuestions,
      freshness: row.freshness as AssistantSessionSummary["freshness"],
      ...(failure ? { failure } : {}),
    });
  }
  return {
    hostInstanceId: input.hostInstanceId,
    authorityRevision: input.authorityRevision,
    revision: input.revision,
    enabled: input.enabled,
    sessions,
  };
}
