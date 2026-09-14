import { z } from "zod";
import type { AssistantHistoryEntry } from "../../../src/shared/assistant-history";
import {
  parseOpenCodeTransportFailure,
  type OpenCodeTransportFailure,
} from "../../../src/shared/opencode-errors";
import {
  parseAssistantLifecycle,
  type AssistantLifecycle,
} from "../../../src/shared/assistant-session";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
const timestamp = z.number().finite().nonnegative();
const entrySchema = z
  .object({
    kind: z.literal("assistant"),
    harnessSessionId: id,
    title: z.string(),
    cwd: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lifecycle: z.custom<AssistantLifecycle>(
      (value) => parseAssistantLifecycle(value) !== null,
    ),
    history: z.enum(["available", "partial", "missing", "unavailable"]),
    nativeResume: z.enum(["unchecked", "available", "missing", "unavailable"]),
    resumeFailure: z
      .custom<OpenCodeTransportFailure>(
        (value) => parseOpenCodeTransportFailure(value) !== null,
      )
      .optional(),
    recordRevision: count.positive().nullable(),
  })
  .refine(
    (entry) => entry.harnessSessionId === entry.lifecycle.harnessSessionId,
  );

export function parseAssistantHistoryEntry(
  value: unknown,
): AssistantHistoryEntry | null {
  const result = entrySchema.safeParse(value);
  return result.success ? result.data : null;
}

const part = z.discriminatedUnion("type", [
  z.object({
    id,
    type: z.literal("text"),
    text: z.string().max(4000),
    truncated: z.boolean(),
  }),
  z.object({
    id,
    type: z.literal("tool"),
    callId: id,
    name: z.string().max(256),
    status: z.enum(["pending", "running", "completed", "error"]),
    input: z.string().max(512),
    output: z.string().max(512).nullable(),
    error: z.string().max(512).nullable(),
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    truncated: z.boolean(),
  }),
  z.object({
    id,
    type: z.literal("file"),
    name: z.string().nullable(),
    mime: z.string(),
  }),
  z.object({ id, type: z.literal("omitted"), nativeType: z.string() }),
]);
const recordSchema = z.object({
  schemaVersion: z.literal(1),
  reconstructed: z.literal(true),
  revision: count.positive(),
  binding: z.object({
    harnessSessionId: id,
    cwd: z.string(),
    conversationId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,128}$/),
  }),
  capturedAt: z.string().datetime(),
  turnCount: count,
  messageCount: count,
  limitations: z.array(z.string()),
  turns: z.array(
    z.object({
      id,
      incomplete: z.boolean(),
      messages: z
        .array(
          z.object({
            id,
            role: z.enum(["user", "assistant"]),
            parentId: id.nullable(),
            createdAt: timestamp,
            completedAt: timestamp.nullable(),
            parts: z.array(part),
          }),
        )
        .min(1),
    }),
  ),
});
export type ReadableAssistantRecord = Omit<
  z.infer<typeof recordSchema>,
  "binding"
>;

/** Decode only displayed fields; accepted context and private binding scope are dropped. */
export function parseReadableAssistantRecord(
  value: unknown,
  entry: AssistantHistoryEntry,
): ReadableAssistantRecord | null {
  const result = recordSchema.safeParse(value);
  if (!result.success) return null;
  const { binding, ...record } = result.data;
  if (
    binding.harnessSessionId !== entry.harnessSessionId ||
    binding.cwd !== entry.cwd ||
    record.revision < (entry.recordRevision ?? 0)
  )
    return null;
  const messages = new Set<string>(),
    parts = new Set<string>();
  for (const turn of record.turns) {
    if (turn.messages[0]!.id !== turn.id || turn.messages[0]!.role !== "user")
      return null;
    for (const message of turn.messages) {
      if (
        messages.has(message.id) ||
        (message.role === "user"
          ? message.id !== turn.id || message.parentId !== null
          : message.parentId !== turn.id)
      )
        return null;
      messages.add(message.id);
      for (const part of message.parts) {
        if (parts.has(part.id)) return null;
        parts.add(part.id);
      }
    }
  }
  return record.turnCount >= record.turns.length &&
    record.messageCount >= messages.size
    ? record
    : null;
}

export async function assistantHistoryRequest(
  path: string,
  bootToken: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    headers: { "X-Harness-Token": bootToken },
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error("Assistant history is unavailable. Try again.");
  return response.json();
}

export async function readAssistantHistory(
  cwd: string,
  bootToken: string,
  signal: AbortSignal,
): Promise<AssistantHistoryEntry[]> {
  const value = await assistantHistoryRequest(
    `/api/sessions/assistant-history?cwd=${encodeURIComponent(cwd)}`,
    bootToken,
    signal,
  );
  const result = z.object({ entries: z.array(entrySchema) }).safeParse(value);
  if (!result.success)
    throw new Error("Assistant history could not be verified.");
  const ids = new Set(
    result.data.entries.map((entry) => entry.harnessSessionId),
  );
  if (ids.size !== result.data.entries.length)
    throw new Error("Assistant history could not be verified.");
  return result.data.entries;
}

export async function readAssistantRecord(
  entry: AssistantHistoryEntry,
  bootToken: string,
  signal: AbortSignal,
): Promise<ReadableAssistantRecord | null> {
  const value = await assistantHistoryRequest(
    `/api/sessions/${encodeURIComponent(entry.harnessSessionId)}/assistant/record`,
    bootToken,
    signal,
  );
  if (value === null) return null;
  const record = parseReadableAssistantRecord(
    (value as { record?: unknown }).record,
    entry,
  );
  if (!record) throw new Error("Assistant history could not be verified.");
  return record;
}
