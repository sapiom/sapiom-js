import { z } from "zod";
import {
  assistantWorkspace,
  type AssistantHistoryEntry,
} from "../../../src/shared/assistant-history";
import { parseAssistantLifecycle } from "../../../src/shared/assistant-session";
import { verifyAssistantContinuationView } from "../../../src/shared/assistant-continuation";
import {
  assistantActionRequest,
  assistantSessionSchema,
} from "./assistant-resume-client";

const requestSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().safe(),
    expectedRecordRevision: z.number().int().positive().safe(),
  })
  .strict();
export type ContinueRequest = z.infer<typeof requestSchema>;
const key = (entry: AssistantHistoryEntry) => {
  if (
    !entry.continuationScope ||
    !/^[a-f\d]{64}$/.test(entry.continuationScope)
  )
    throw new Error(
      "Continuation is unavailable for this workspace. Your saved history is still readable.",
    );
  return `studio.assistant-continue.v1:${entry.continuationScope}:${entry.harnessSessionId}`;
};
const storageError = () =>
  new Error(
    "Studio could not save or verify this continuation request. Try again.",
  );
export function savedContinueRequest(
  entry: AssistantHistoryEntry,
): ContinueRequest | null {
  try {
    const value = localStorage.getItem(key(entry));
    return value === null ? null : requestSchema.parse(JSON.parse(value));
  } catch {
    throw storageError();
  }
}
function prepare(
  entry: AssistantHistoryEntry,
  recordRevision: number | null,
  rejected?: ContinueRequest,
): ContinueRequest {
  const saved = savedContinueRequest(entry);
  if (
    rejected &&
    (!saved ||
      saved.operationId !== rejected.operationId ||
      saved.expectedRevision !== rejected.expectedRevision ||
      saved.expectedRecordRevision !== rejected.expectedRecordRevision)
  )
    throw new Error(
      "The saved continuation request changed. Retry its current request before starting another.",
    );
  if (saved && !rejected) return saved;
  if (recordRevision === null)
    throw new Error("No readable Assistant record is available to continue.");
  const request = requestSchema.parse({
    operationId: crypto.randomUUID(),
    expectedRevision: entry.lifecycle.revision,
    expectedRecordRevision: recordRevision,
  });
  try {
    localStorage.setItem(key(entry), JSON.stringify(request));
    if (savedContinueRequest(entry)?.operationId !== request.operationId)
      throw storageError();
  } catch {
    throw storageError();
  }
  return request;
}
/** Serialize creation across tabs before any request can leave the browser. */
export async function prepareContinueRequest(
  entry: AssistantHistoryEntry,
  recordRevision: number | null,
  /** Only an explicit new-operation action after a confirmed lifecycle conflict. */
  rejected?: ContinueRequest,
): Promise<ContinueRequest> {
  if (!navigator.locks) throw storageError();
  return navigator.locks.request(key(entry), () =>
    prepare(entry, recordRevision, rejected),
  );
}
export function completeContinueRequest(
  entry: AssistantHistoryEntry,
  operationId: string,
): void {
  try {
    if (savedContinueRequest(entry)?.operationId === operationId)
      localStorage.removeItem(key(entry));
  } catch {
    /* A retained receipt can safely reconcile again. */
  }
}

export async function continueAssistantRequest(
  entry: AssistantHistoryEntry,
  request: ContinueRequest,
  bootToken: string,
  signal: AbortSignal,
) {
  key(entry);
  requestSchema.parse(request);
  const value = await assistantActionRequest(
    entry,
    "continue",
    request,
    bootToken,
    signal,
  );
  const session = assistantSessionSchema.safeParse(value.session);
  const attachment = value.attachment as Record<string, unknown> | null;
  const lifecycle = parseAssistantLifecycle(attachment?.lifecycle);
  const continuation = await verifyAssistantContinuationView(
    value.continuation,
    typeof attachment?.conversationId === "string"
      ? attachment.conversationId
      : "",
  );
  if (
    !session.success ||
    session.data.id === entry.harnessSessionId ||
    session.data.cwd !== assistantWorkspace(entry).cwd ||
    !session.data.agentMapIdentity ||
    session.data.agentMapIdentity.sessionId !== session.data.id ||
    !lifecycle ||
    lifecycle.harnessSessionId !== session.data.id ||
    lifecycle.lifecycle !== "open" ||
    lifecycle.revision < 1 ||
    !z.string().uuid().safeParse(attachment?.lease).success ||
    !continuation ||
    continuation.operationId !== request.operationId ||
    continuation.sourceSessionId !== entry.harnessSessionId ||
    continuation.sourceRecordRevision !== request.expectedRecordRevision
  )
    throw new Error(
      "The prepared continuation could not be verified. Your original history is still available.",
    );
  return { session: session.data, lifecycle, continuation };
}
