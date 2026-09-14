import type {
  AssistantLifecycle,
  AssistantSessionView,
} from "./assistant-session.js";
import type { OpenCodeTransportFailure } from "./opencode-errors.js";

/** Additive history entry: a Studio identity does not require a Terminal vendor ID. */
export interface AssistantHistoryEntry {
  kind: "assistant";
  harnessSessionId: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: AssistantLifecycle;
  history: AssistantSessionView["history"];
  nativeResume: AssistantSessionView["nativeResume"];
  resumeFailure?: OpenCodeTransportFailure;
  recordRevision: number | null;
}
