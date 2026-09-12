import type { OpenCodeTransportFailure } from "./opencode-errors.js";

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
