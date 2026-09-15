import type {
  AssistantLifecycle,
  AssistantSessionView,
} from "./assistant-session.js";
import type { OpenCodeTransportFailure } from "./opencode-errors.js";
import { z } from "zod";

const workspacePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !value.includes("\0") && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value),
  );
/** Verified by the server against the current Studio binding, never inferred by the browser. */
export const assistantHistoryWorkspaceSchema = z
  .object({
    cwd: workspacePath,
    canonicalCwd: workspacePath,
  })
  .strict();
export type AssistantHistoryWorkspace = z.infer<
  typeof assistantHistoryWorkspaceSchema
>;

export const assistantWorkspace = (
  entry: AssistantHistoryEntry,
): AssistantHistoryWorkspace =>
  entry.workspace ?? { cwd: entry.cwd, canonicalCwd: entry.cwd };

export const sameAssistantWorkspace = (
  a: AssistantHistoryEntry,
  b: AssistantHistoryEntry,
): boolean =>
  a.cwd === b.cwd && assistantWorkspace(a).cwd === assistantWorkspace(b).cwd;

export const assistantHistoryMatches = (
  entry: AssistantHistoryEntry | undefined,
  studioId: string | undefined,
  cwd: string,
): boolean =>
  !!entry &&
  entry.harnessSessionId === studioId &&
  assistantWorkspace(entry).cwd === cwd;

export interface AssistantHistoryList {
  workspace: AssistantHistoryWorkspace;
  entries: AssistantHistoryEntry[];
}

/** Additive history entry: a Studio identity does not require a Terminal vendor ID. */
export interface AssistantHistoryEntry {
  kind: "assistant";
  harnessSessionId: string;
  title: string;
  cwd: string;
  /** Current launch spelling paired with the canonical record/native workspace. */
  workspace?: AssistantHistoryWorkspace;
  createdAt: string;
  updatedAt: string;
  lifecycle: AssistantLifecycle;
  history: AssistantSessionView["history"];
  nativeResume: AssistantSessionView["nativeResume"];
  resumeFailure?: OpenCodeTransportFailure;
  recordRevision: number | null;
  /** Opaque stable retry partition, authorized and projected by the server. */
  continuationScope?: string;
}
