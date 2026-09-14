/** Public provenance and exact seed attestation, projected only from a verified receipt. */
export interface AssistantContinuationView {
  operationId: string;
  sourceSessionId: string;
  sourceRecordRevision: number;
  capturedAt: string;
  retainedTurns: number;
  omittedTurns: number;
  seed: {
    conversationId: string;
    messageId: string;
    partId: string;
    text: string;
    sha256: string;
  };
}

export function parseAssistantContinuationView(
  value: unknown,
  conversationId?: string,
): AssistantContinuationView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const seed = v.seed as Record<string, unknown> | null;
  if (
    !seed ||
    typeof seed !== "object" ||
    Array.isArray(seed) ||
    typeof v.operationId !== "string" ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
      v.operationId,
    ) ||
    typeof v.sourceSessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v.sourceSessionId) ||
    !Number.isSafeInteger(v.sourceRecordRevision) ||
    (v.sourceRecordRevision as number) < 1 ||
    typeof v.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(v.capturedAt)) ||
    !Number.isSafeInteger(v.retainedTurns) ||
    (v.retainedTurns as number) < 1 ||
    (v.retainedTurns as number) > 12 ||
    !Number.isSafeInteger(v.omittedTurns) ||
    (v.omittedTurns as number) < 0 ||
    typeof seed.conversationId !== "string" ||
    !/^ses_[A-Za-z0-9_-]{1,128}$/.test(seed.conversationId) ||
    (conversationId !== undefined && conversationId !== seed.conversationId) ||
    typeof seed.messageId !== "string" ||
    !/^msg_[A-Za-z0-9_-]{1,128}$/.test(seed.messageId) ||
    typeof seed.partId !== "string" ||
    !/^prt_[A-Za-z0-9_-]{1,128}$/.test(seed.partId) ||
    typeof seed.text !== "string" ||
    !seed.text ||
    seed.text.length > 24_000 ||
    typeof seed.sha256 !== "string" ||
    !/^[a-f\d]{64}$/.test(seed.sha256)
  )
    return null;
  return {
    operationId: v.operationId,
    sourceSessionId: v.sourceSessionId,
    sourceRecordRevision: v.sourceRecordRevision as number,
    capturedAt: v.capturedAt,
    retainedTurns: v.retainedTurns as number,
    omittedTurns: v.omittedTurns as number,
    seed: {
      conversationId: seed.conversationId,
      messageId: seed.messageId,
      partId: seed.partId,
      text: seed.text,
      sha256: seed.sha256,
    },
  };
}

/** Browser callers verify the exact bounded brief before adopting its attestation. */
export async function verifyAssistantContinuationView(
  value: unknown,
  conversationId?: string,
): Promise<AssistantContinuationView | null> {
  const parsed = parseAssistantContinuationView(value, conversationId);
  if (!parsed) return null;
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parsed.seed.text),
  );
  const hex = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return hex === parsed.seed.sha256 ? parsed : null;
}
