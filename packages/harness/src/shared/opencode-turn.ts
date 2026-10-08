import {
  openCodeCompletionTokens,
  openCodeVisibleText,
  parseOpenCodeCompletion,
} from "./opencode-completion.js";

/** Use native messages: the UI adapter merges tool steps and final answers. */
export interface OpenCodeTurnMessage {
  info?: {
    id: string;
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
    type: string;
    text?: string;
    ignored?: boolean;
    synthetic?: boolean;
    tool?: string;
    state?: { status?: string; input?: unknown };
    metadata?: { compaction_continue?: unknown };
  }[];
}

export const finalResponseAgent = "sapiom-final-response";
export const turnRecoveryAgent = "sapiom-turn-recovery";

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
): {
  status: "ready" | "working" | "finished" | "stopped" | "failed" | "unknown";
  missing?: string;
} {
  if (!status) return { status: "unknown" };
  if (status !== "idle") return { status: "working" };
  const newestFirst = [...messages].reverse();
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
  const token = openCodeCompletionTokens(messages).get(user.info!.id);
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
