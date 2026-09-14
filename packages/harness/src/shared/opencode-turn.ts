import {
  openCodeCompletionTokens,
  openCodeVisibleText,
  parseOpenCodeCompletion,
} from "./opencode-completion.js";
import type { AssistantContinuationView } from "./assistant-continuation.js";

/** Use native messages: the UI adapter merges tool steps and final answers. */
export interface OpenCodeTurnMessage {
  info?: {
    id: string;
    sessionID?: string;
    role: string;
    parentID?: string;
    agent?: string;
    summary?: unknown;
    finish?: string;
    error?: unknown;
    system?: string;
    time: { created?: number; completed?: number };
  };
  parts: readonly {
    id?: string;
    messageID?: string;
    sessionID?: string;
    type: string;
    text?: string;
    ignored?: boolean;
    synthetic?: boolean;
    tool?: string;
    state?: { status?: string; input?: unknown };
    metadata?: { compaction_continue?: unknown; sapiomContinuation?: unknown };
  }[];
}

export const finalResponseAgent = "sapiom-final-response";
export const turnRecoveryAgent = "sapiom-turn-recovery";

/** Only a server-attested exact no-reply seed is recorded input, not a human task. */
export function isAssistantContinuationSeed(
  message: OpenCodeTurnMessage | undefined,
  continuation?: AssistantContinuationView | null,
): boolean {
  if (!message || !continuation) return false;
  const { seed, operationId } = continuation;
  const part = message.parts[0];
  const raw = part?.metadata?.sapiomContinuation;
  const marker =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  return (
    message.info?.role === "user" &&
    message.info.id === seed.messageId &&
    message.info.sessionID === seed.conversationId &&
    message.parts.length === 1 &&
    part?.id === seed.partId &&
    part.messageID === seed.messageId &&
    part.sessionID === seed.conversationId &&
    part.type === "text" &&
    part.synthetic === true &&
    part.ignored === false &&
    part.text === seed.text &&
    marker?.operationId === operationId &&
    marker.briefHash === seed.sha256
  );
}

export function assistantTaskMessages<T extends OpenCodeTurnMessage>(
  messages: readonly T[],
  continuation?: AssistantContinuationView | null,
): readonly T[] {
  if (!continuation) return messages;
  return messages.filter(
    (message) =>
      !isAssistantContinuationSeed(message, continuation) ||
      messages.some(
        (answer) =>
          answer.info?.role === "assistant" &&
          answer.info.parentID === message.info?.id,
      ),
  );
}

export function openCodeResult(
  message: OpenCodeTurnMessage | undefined,
  token: string | undefined,
) {
  if (
    !message?.info?.time.completed ||
    message.info.error ||
    message.info.finish !== "stop" ||
    !token ||
    message.parts.some((part) => part.type === "tool")
  )
    return;
  return parseOpenCodeCompletion(
    message.parts
      .filter(
        (part) => part.type === "text" && !part.ignored && !part.synthetic,
      )
      .map((part) => part.text ?? "")
      .join(""),
    token,
  );
}

export function openCodeTurn(
  messages: readonly OpenCodeTurnMessage[],
  status: string | undefined,
  /** A token resolved against full history when evaluating an isolated archived turn. */
  completionToken?: string,
  continuation?: AssistantContinuationView | null,
): {
  status: "ready" | "working" | "finished" | "stopped" | "failed" | "unknown";
  missing?: string;
} {
  if (!status) return { status: "unknown" };
  if (status !== "idle") return { status: "working" };
  const newestFirst = [
    ...assistantTaskMessages(messages, continuation),
  ].reverse();
  const user = newestFirst.find((message) => message.info?.role === "user");
  if (!user) return { status: "ready" };
  // Older previews only summarized a stopped run; that did not finish its task.
  if (user.info?.agent === finalResponseAgent) return { status: "failed" };
  const answer = newestFirst.find(
    ({ info }) =>
      info?.role === "assistant" &&
      !info.summary &&
      info.parentID === user.info?.id,
  );
  if (!answer?.info || !answer.info.time.completed) return { status: "failed" };
  if (answer.info.agent === finalResponseAgent) return { status: "failed" };
  const token =
    completionToken ?? openCodeCompletionTokens(messages).get(user.info!.id);
  if (answer.info.error) return { status: "failed" };
  if (token) {
    const result = openCodeResult(answer, token);
    if (result) return { status: result.status };
    const tools = answer.parts.filter((part) => part.type === "tool");
    const text = answer.parts
      .filter(
        (part) => part.type === "text" && !part.ignored && !part.synthetic,
      )
      .map((part) => part.text ?? "")
      .join("");
    // An omitted/malformed declaration can continue from completed results;
    // permission failures, cancelled tools, and native errors cannot.
    return {
      status:
        answer.info.finish === "stop" &&
        tools.length === 0 &&
        openCodeVisibleText(text, token).trim()
          ? "stopped"
          : "failed",
      ...(user.info?.agent === "build" &&
      answer.info.agent === "build" &&
      ["stop", "tool-calls"].includes(answer.info.finish ?? "") &&
      tools.every((part) => part.state?.status === "completed")
        ? { missing: answer.info.id }
        : {}),
    };
  }
  // A preamble or a completed tool step is not the final response.
  if (answer.info.finish !== "stop") return { status: "failed" };
  if (
    answer.parts.some(
      (part) =>
        part.type === "text" &&
        !part.ignored &&
        !part.synthetic &&
        part.text?.trim(),
    )
  )
    return { status: "finished" };
  return {
    status: "failed",
    ...(user.info?.agent === "build" &&
    answer.info.agent === "build" &&
    !answer.parts.some((part) => part.type === "tool")
      ? { missing: answer.info.id }
      : {}),
  };
}
