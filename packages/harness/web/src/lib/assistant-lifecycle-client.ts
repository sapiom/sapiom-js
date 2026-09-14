import type { AssistantLifecycle } from "../../../src/shared/assistant-session";
import {
  parseAssistantContinuationView,
  type AssistantContinuationView,
} from "../../../src/shared/assistant-continuation";

export interface AssistantAttachment {
  conversationId: string;
  lease: string;
  lifecycle: AssistantLifecycle;
  continuation?: AssistantContinuationView;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A foreign or malformed descriptor must never authorize an attach. */
export function parseAssistantLifecycle(
  value: unknown,
  harnessSessionId: string,
): AssistantLifecycle | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.harnessSessionId !== harnessSessionId ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !["open", "ending", "ended"].includes(value.lifecycle as string) ||
    !["enabled", "paused"].includes(value.execution as string) ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0
  )
    return null;
  return {
    version: 1,
    harnessSessionId,
    revision: value.revision as number,
    lifecycle: value.lifecycle as AssistantLifecycle["lifecycle"],
    execution: value.execution as AssistantLifecycle["execution"],
    updatedAt: value.updatedAt as number,
  };
}

/** Starting a runtime advances once; attaching its existing lease does not. */
export function parseAssistantAttachment(
  value: unknown,
  harnessSessionId: string,
  expectedRevision: number,
): AssistantAttachment | null {
  if (!object(value)) return null;
  const lifecycle = parseAssistantLifecycle(value.lifecycle, harnessSessionId);
  const continuation =
    value.continuation == null
      ? null
      : parseAssistantContinuationView(
          value.continuation,
          value.conversationId as string,
        );
  if (
    !lifecycle ||
    (value.continuation != null && !continuation) ||
    lifecycle.lifecycle !== "open" ||
    ![expectedRevision, expectedRevision + 1].includes(lifecycle.revision) ||
    typeof value.conversationId !== "string" ||
    !/^ses_[A-Za-z0-9_-]{1,128}$/.test(value.conversationId) ||
    typeof value.lease !== "string" ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
      value.lease,
    )
  )
    return null;
  return {
    conversationId: value.conversationId,
    lease: value.lease,
    lifecycle,
    ...(continuation ? { continuation } : {}),
  };
}
