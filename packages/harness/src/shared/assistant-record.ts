import type { AcceptedContextRef } from "@sapiom/opencode";

/** Native identity is separate from the Studio session and current authorization. */
export interface AssistantRecordBinding {
  harnessSessionId: string;
  contextAuthorityScope: string;
  conversationId: string;
  cwd: string;
}

export type AssistantRecordPart =
  | { id: string; type: "text"; text: string; truncated: boolean }
  | {
      id: string;
      type: "tool";
      callId: string;
      name: string;
      status: "pending" | "running" | "completed" | "error";
      input: string;
      output: string | null;
      error: string | null;
      startedAt: number | null;
      completedAt: number | null;
      truncated: boolean;
    }
  | { id: string; type: "file"; name: string | null; mime: string }
  | { id: string; type: "omitted"; nativeType: string };

export interface AssistantRecordMessage {
  id: string;
  role: "user" | "assistant";
  parentId: string | null;
  createdAt: number;
  completedAt: number | null;
  parts: AssistantRecordPart[];
}

export type AssistantRecordLimitation =
  | "private-parts-omitted"
  | "unknown-parts"
  | "attachment-content-omitted"
  | "accepted-context-unavailable"
  | "field-truncation"
  | "dropped-early-turns"
  | "dropped-message-content";

/** A bounded reconstruction, never a native resume credential or replay log. */
export interface AssistantRecord {
  schemaVersion: 1;
  binding: AssistantRecordBinding;
  revision: number;
  capturedAt: string;
  reconstructed: true;
  turns: {
    id: string;
    messages: AssistantRecordMessage[];
    incomplete: boolean;
    acceptedContext: AcceptedContextRef | null;
  }[];
  /** Counts before compaction; the retained excerpt may be shorter. */
  turnCount: number;
  messageCount: number;
  limitations: AssistantRecordLimitation[];
}
