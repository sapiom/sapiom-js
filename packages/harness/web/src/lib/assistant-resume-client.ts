import { z } from "zod";
import type { HarnessSession } from "@shared/types";
import type { AssistantHistoryEntry } from "../../../src/shared/assistant-history";
import { parseAssistantLifecycle } from "../../../src/shared/assistant-session";
import { parseOpenCodeTransportFailure } from "../../../src/shared/opencode-errors";
import { parseAssistantHistoryEntry } from "./assistant-history-client";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
export const assistantSessionSchema = z.object({
  id,
  cwd: z.string(),
  title: z.string(),
  harness: z.enum(["claude-code", "codex"]),
  agentSessionId: z.string().nullable(),
  boundWorkflowPath: z.string().nullable(),
  status: z.enum(["starting", "running", "exited"]),
  ready: z.boolean(),
  terminalState: z.literal("not-started").optional(),
  createdAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
  exitCode: z.number().int().nullable().optional(),
  exitTail: z.string().nullable().optional(),
  mcpAuthState: z
    .enum(["current", "restart-required", "restarting", "not-applicable"])
    .optional(),
  agentMapIdentity: z
    .object({ projectId: id, sessionId: id, userId: z.string() })
    .optional(),
  rehydratedFrom: z.string().nullable().optional(),
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export async function assistantActionRequest(
  entry: AssistantHistoryEntry,
  action: "inspect" | "resume" | "continue",
  body: object,
  bootToken: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(entry.harnessSessionId)}/assistant/${action}`,
    {
      method: "POST",
      headers: {
        "X-Harness-Token": bootToken,
        "Content-Type": "application/json",
      },
      credentials: "omit",
      cache: "no-store",
      signal,
      body: JSON.stringify(body),
    },
  );
  const value = object(await response.json().catch(() => null));
  if (!response.ok)
    throw new Error(
      parseOpenCodeTransportFailure(value.failure ?? value.error)?.message ??
        "Assistant could not be restored. Your saved history is still available. Retry to check the same operation.",
    );
  return value;
}

export async function inspectAssistant(
  entry: AssistantHistoryEntry,
  bootToken: string,
  signal: AbortSignal,
): Promise<AssistantHistoryEntry> {
  const value = await assistantActionRequest(
    entry,
    "inspect",
    { expectedRevision: entry.lifecycle.revision },
    bootToken,
    signal,
  );
  const next = parseAssistantHistoryEntry(value.entry);
  if (
    !next ||
    next.harnessSessionId !== entry.harnessSessionId ||
    next.cwd !== entry.cwd ||
    next.lifecycle.revision !== entry.lifecycle.revision ||
    next.nativeResume === "unchecked"
  )
    throw new Error("Resume availability could not be verified. Check again.");
  return next;
}

export async function resumeAssistantRequest(
  entry: AssistantHistoryEntry,
  operationId: string,
  bootToken: string,
  signal: AbortSignal,
) {
  const value = await assistantActionRequest(
    entry,
    "resume",
    { expectedRevision: entry.lifecycle.revision, operationId },
    bootToken,
    signal,
  );
  const session = assistantSessionSchema.safeParse(value.session);
  const attachment = object(value.attachment);
  const lifecycle = parseAssistantLifecycle(attachment.lifecycle);
  if (
    !session.success ||
    session.data.id !== entry.harnessSessionId ||
    session.data.cwd !== entry.cwd ||
    (session.data.agentMapIdentity &&
      session.data.agentMapIdentity.sessionId !== entry.harnessSessionId) ||
    !lifecycle ||
    lifecycle.harnessSessionId !== entry.harnessSessionId ||
    lifecycle.lifecycle !== "open" ||
    lifecycle.revision <= entry.lifecycle.revision ||
    !z.string().uuid().safeParse(attachment.lease).success ||
    !z
      .string()
      .regex(/^ses_[A-Za-z0-9_-]{1,128}$/)
      .safeParse(attachment.conversationId).success
  )
    throw new Error(
      "The restored Assistant could not be verified. Your saved history is still available.",
    );
  return { session: session.data satisfies HarnessSession, lifecycle };
}
